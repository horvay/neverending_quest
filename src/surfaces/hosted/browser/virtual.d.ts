/** Files the hosted build bundles; see ../build.ts. Mount point → relative path → text. */
declare module "virtual:nq-bundled-files" {
  const files: Record<string, Record<string, string>>;
  export default files;
}
