import { AlmanacBook } from "../almanac.tsx";
import { useAlmanac } from "../almanac/data.ts";

/** The Almanac on its own, opened from the title page. */
export function AlmanacSheet(props: { onClose: () => void }) {
  const almanac = useAlmanac();
  return (
    <div class="home-settings-backdrop">
      <section
        class="home-settings home-local is-almanac"
        role="dialog"
        aria-modal="true"
        aria-labelledby="almanac-title"
      >
        <AlmanacBook almanac={almanac} closeLabel="Close" onClose={props.onClose} />
      </section>
    </div>
  );
}

export function LocalLoadingPanel(props: { message?: string; onCancel: () => void }) {
  return (
    <div class="home-settings-backdrop">
      <section
        class="home-settings home-loading"
        role="dialog"
        aria-modal="true"
        aria-busy="true"
        aria-labelledby="home-loading-title"
        tabIndex={-1}
        data-modal-first
      >
        <div class="home-loading-body">
          <p class="home-loading-kicker">This computer</p>
          <h2 id="home-loading-title">Loading local Game Master</h2>
          <div class="home-loading-line" aria-hidden="true">
            <span />
          </div>
          <p class="home-loading-status" role="status" aria-live="polite">
            {props.message || "Starting the local model…"}
          </p>
          <p class="home-loading-note">
            Large models can take a little while. Home will stay locked until
            the Game Master is ready.
          </p>
          <button
            type="button"
            class="home-loading-cancel"
            onClick={props.onCancel}
          >
            Cancel loading
          </button>
        </div>
      </section>
    </div>
  );
}
