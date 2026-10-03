"""Give an EXL3 model a quantized output head, in a new model folder.

An EXL3 conversion with `--head_bits 16` keeps the 262144-row head in fp16, and
exl3xpu reads all of it on every decode step (2.8 GB for Gemma 4 31B, about
4.7 ms on an Arc Pro B70). This quantizes just that head to K-bit EXL3 (mul1
codebook, no calibration data) and writes a sibling folder that hard-links every
other file, so no weights are copied. The new folder unties the head
(`tie_word_embeddings: false`), which exl3xpu then runs as an EXL3 linear.

The head is too large for exllamav3's quantizer on a 12 GB card in one piece, so
its regularization (output scales, Hadamard rotations, input scales, global
scale) runs over the whole matrix in column chunks, and the already-regularized
columns are then tile-quantized chunk by chunk; columns quantize independently,
so the result matches a whole-tensor run.

Needs a CUDA GPU and exllamav3 (tested with 1.5.3):

    uv venv -p 3.12 venv && . venv/bin/activate
    uv pip install torch --index-url https://download.pytorch.org/whl/cu132
    uv pip install exllamav3==1.5.3 safetensors
    python scripts/exl3_quantize_head.py models/Twilight-Embrace-31B-exl3-4.0bpw --bits 6

Measured on Twilight Embrace 31B: mean NLL 0.1555 vs 0.1545 with the fp16 head
(+0.6%), single-session decode about +6%.
"""
import argparse, json, os, time

import torch
from safetensors import safe_open
from safetensors.torch import save_file
import exllamav3.modules.quant.exl3_lib.quantize as Q

ap = argparse.ArgumentParser()
ap.add_argument("model", help="EXL3 model folder with an unquantized lm_head.weight")
ap.add_argument("--bits", type=int, default=6)
ap.add_argument("--out", help="new folder (default: <model>-h<bits>)")
ap.add_argument("--chunk", type=int, default=32768, help="output columns per GPU chunk (multiple of 128)")
args = ap.parse_args()
SRC = os.path.abspath(args.model.rstrip("/"))
DST = os.path.abspath(args.out or f"{SRC}-h{args.bits}")
K = args.bits

idx = json.load(open(f"{SRC}/model.safetensors.index.json"))
shard = idx["weight_map"]["lm_head.weight"]
os.makedirs(DST, exist_ok=True)
with safe_open(f"{SRC}/{shard}", "pt", device="cpu") as f:
    meta = f.metadata()
    keep = {k: f.get_tensor(k) for k in f.keys() if k != "lm_head.weight"}
    weight = f.get_tensor("lm_head.weight").float().t().contiguous()  # (in, out) on CPU
k_in, n_out = weight.shape
print(f"lm_head {n_out} x {k_in}", flush=True)

dev = torch.device("cuda:0")
chunks = [slice(s, min(s + args.chunk, n_out)) for s in range(0, n_out, args.chunk)]
qa = {"seed": 1, "K": K, "devices": [0], "device_ratios": None, "apply_out_scales": True,
      "debug_dir": os.path.join(DST, ".quant-debug"), "mul1": True}
t0 = time.time()
torch.manual_seed(1)
su0 = (torch.randn(k_in, device=dev).sign() + 1e-5).sign().to(torch.float).unsqueeze(1)
sv0 = (torch.randn(n_out).sign() + 1e-5).sign().to(torch.float).unsqueeze(0)

# exllamav3's regularize(), over the whole matrix: the input-side scales reduce over every column
ocs = torch.cat([Q.block_rms(weight[:, c].to(dev), dim=0, keepdim=True).cpu() for c in chunks], dim=1)
ocs /= ocs.mean()
zero_cols = ocs.abs() < 1e-30
ocs[zero_cols] = 0.1
sv = (sv0 * ocs + 1e-10).float()
sumsq = torch.zeros(k_in, 1, device=dev)
for c in chunks:
    w = weight[:, c].to(dev) / sv[:, c].to(dev)
    Q.blockwise_preapply_had_r_(w, Q.had_n)
    sumsq += w.square().sum(dim=1, keepdim=True)
    weight[:, c] = w.cpu()
sv[zero_cols] = 0.0
ics = (sumsq / n_out).sqrt()
ics[ics.abs() < 1e-30] = 0.1
su = (su0 * ics / (-Q.codebook_scale) + 1e-10).float()
for c in chunks:
    w = weight[:, c].to(dev) / su
    Q.blockwise_preapply_had_l_(w, Q.had_k)
    weight[:, c] = w.cpu()
g_scale, _ = Q.g_scale_gss(weight[:, chunks[len(chunks) // 2]].to(dev), False, qa)
su /= g_scale
print(f"regularized in {time.time() - t0:.0f} s, global scale {g_scale:.5f}", flush=True)

packed = []
for i, c in enumerate(chunks):
    w = weight[:, c].to(dev) * g_scale
    _, enc, mse = Q.fallback_quant(w, dev, qa)
    packed.append(Q.pack_trellis(enc, qa).cpu())
    del w, enc
    torch.cuda.empty_cache()
    print(f"chunk {i + 1}/{len(chunks)}: mse {float(mse):.6f}, {time.time() - t0:.0f} s", flush=True)

head = {
    "lm_head.suh": su.flatten().contiguous().half().cpu(),
    "lm_head.svh": sv.flatten().contiguous().half().cpu(),
    "lm_head.trellis": torch.cat(packed, dim=1),
    "lm_head.mul1": torch.tensor(Q.codebook_mul1_mult, dtype=torch.uint32).view(torch.int),
}
save_file({**keep, **head}, f"{DST}/{shard}", metadata=meta)

cfg = json.load(open(f"{SRC}/config.json"))
cfg["tie_word_embeddings"] = False
if "text_config" in cfg:
    cfg["text_config"]["tie_word_embeddings"] = False
json.dump(cfg, open(f"{DST}/config.json", "w"), indent=2)

qc = json.load(open(f"{SRC}/quantization_config.json"))
qc["head_bits"] = K
qc["tensor_storage"]["lm_head"] = {
    "stored_tensors": {k: {"shape": list(v.shape), "n_bytes": v.numel() * v.element_size(), "dtype": str(v.dtype)}
                       for k, v in head.items()},
    "quant_format": "exl3",
    "bits_per_weight": K,
    "mul1_multiplier": int(Q.codebook_mul1_mult),
}
json.dump(qc, open(f"{DST}/quantization_config.json", "w"), indent=2)

idx["weight_map"].pop("lm_head.weight")
for k in head:
    idx["weight_map"][k] = shard
json.dump(idx, open(f"{DST}/model.safetensors.index.json", "w"), indent=2)

# every other file: hard links (no copies, and they resolve inside exl3xpu's sandbox)
for name in os.listdir(SRC):
    if name in (shard, "config.json", "quantization_config.json", "model.safetensors.index.json"):
        continue
    if os.path.isfile(f"{SRC}/{name}") and not os.path.exists(f"{DST}/{name}"):
        os.link(f"{SRC}/{name}", f"{DST}/{name}")
print(f"wrote {DST} in {time.time() - t0:.0f} s", flush=True)
