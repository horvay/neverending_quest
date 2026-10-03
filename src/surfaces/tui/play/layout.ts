import {
  BoxRenderable,
  InputRenderable,
  ScrollBoxRenderable,
  StyledText,
  TextareaRenderable,
  TextRenderable,
  type CliRenderer,
} from "@opentui/core";

export const PLAY_PLACEHOLDER = "What do you do?";

/**
 * The play screen: the story (or a read view) scrolling above a dice line,
 * the status line and the input, with one edit overlay on top for Edit, Ink
 * and Scratch.
 */
export type PlayLayout = {
  root: BoxRenderable;
  /** Show the story, following its end as it grows. */
  showStory(content: StyledText): void;
  /** Show a read view from its top. */
  showView(content: string): void;
  /** Page the story or view up (negative) or down by whole screens. */
  page(direction: -1 | 1): void;
  setDice(line: string | undefined): void;
  setStatus(line: string): void;
  input: InputRenderable;
  overlay: {
    open(opts: { title: string; hint: string; text: string }): void;
    close(): void;
    readonly visible: boolean;
    text(): string;
    setText(text: string): void;
    onSave(save: () => void): void;
  };
  /** Point keyboard input at the overlay while it is open, else the input. */
  focus(): void;
  unmount(): void;
};

export function mountPlayLayout(renderer: CliRenderer): PlayLayout {
  const root = new BoxRenderable(renderer, {
    id: "root-col",
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const scroll = new ScrollBoxRenderable(renderer, {
    id: "story-scroll",
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    scrollX: false,
  });
  const story = new TextRenderable(renderer, { id: "story", content: "" });
  scroll.add(story);
  const dice = new TextRenderable(renderer, {
    id: "dice",
    content: "",
    height: 1,
    visible: false,
  });
  const status = new TextRenderable(renderer, {
    id: "status",
    content: "Idle · 0 turns",
    height: 1,
  });
  const input = new InputRenderable(renderer, {
    id: "input",
    width: "100%",
    placeholder: PLAY_PLACEHOLDER,
  });
  const overlay = new BoxRenderable(renderer, {
    id: "edit-overlay",
    position: "absolute",
    top: 1,
    left: 2,
    right: 2,
    height: 10,
    border: true,
    title: "Edit",
    visible: false,
    zIndex: 10,
    flexDirection: "column",
    backgroundColor: "#101010",
    shouldFill: true,
  });
  const editBox = new TextareaRenderable(renderer, {
    id: "edit-box",
    flexGrow: 1,
    backgroundColor: "#101010",
    focusedBackgroundColor: "#101010",
    keyBindings: [{ name: "s", ctrl: true, action: "submit" }],
  });
  editBox.focusable = false;
  const editHint = new TextRenderable(renderer, {
    id: "edit-hint",
    content: "",
    height: 1,
  });
  overlay.add(editBox);
  overlay.add(editHint);
  root.add(scroll);
  root.add(dice);
  root.add(status);
  root.add(input);
  root.add(overlay);
  renderer.root.add(root);
  input.focus();

  let following = true;
  const focus = () => {
    if (overlay.visible) {
      input.blur();
      input.focusable = false;
      editBox.focusable = true;
      editBox.focus();
      return;
    }
    editBox.blur();
    editBox.focusable = false;
    input.focusable = true;
    input.focus();
  };

  return {
    root,
    showStory(content) {
      story.content = content;
      if (!following) {
        following = true;
        scroll.stickyScroll = true;
        scroll.scrollTo(scroll.scrollHeight);
      }
    },
    showView(content) {
      const fresh = following || story.plainText !== content;
      story.content = content;
      if (following) {
        following = false;
        scroll.stickyScroll = false;
      }
      if (fresh) scroll.scrollTo(0);
    },
    page(direction) {
      scroll.scrollBy(direction * Math.max(1, scroll.height - 2));
    },
    setDice(line) {
      dice.content = line ?? "";
      dice.visible = Boolean(line);
    },
    setStatus(line) {
      status.content = line;
    },
    input,
    overlay: {
      open({ title, hint, text }) {
        overlay.title = title;
        editHint.content = hint;
        // Ink and Scratch need room; an edited line does not
        overlay.height = title === "Edit" ? 10 : Math.max(10, renderer.height - 6);
        editBox.setText(text);
        overlay.visible = true;
        focus();
      },
      close() {
        overlay.visible = false;
        focus();
      },
      get visible() {
        return overlay.visible;
      },
      text: () => editBox.plainText,
      setText: (text) => editBox.setText(text),
      onSave(save) {
        editBox.onSubmit = () => save();
      },
    },
    focus,
    unmount() {
      try {
        renderer.root.remove(root);
      } catch {
        // already gone with the renderer
      }
    },
  };
}
