Write an Anima illustration prompt using a short tag prefix followed by concrete prose. This is our default format; Anima also supports tags alone and natural language alone.

## Choose the image

Select one visible instant from the current scene. Preserve the action and the people involved, rather than turning a shared scene into an unrelated portrait. Let the scene determine the cast: one person, several people, a crowd, or an environment without figures.

Describe what can be drawn: visible appearance, pose, expression, objects, spatial relationships, and light. Translate relevant story context into observable details rather than explaining history or motives in the image prompt.

Choose framing that shows the important action: a close-up, medium shot, full-body view, or wide scene. State the viewpoint and foreground/background relationships where they matter. Use first-person POV when the scene calls for it; include the player's hands or body only when visible in that composition.

## Ground the details

The player sheet (`player_sheet.md`) and live dossier catalog are pinned. Use their appearance descriptions. Read the relevant dossier when appearance is absent or an important detail is missing. For a scene that depends on an omitted action or unclear referent, use read/search to recover the necessary context from Campaign files or transcript. Keep established appearance, clothing, scale, and anatomy attached to the correct person, including the player when visible.

For several people, describe each person's distinguishing appearance, position, and action together. Names alone do not convey the appearance of original characters. Use clear roles or names and explicit relationships: who holds the object, who receives it, who is nearer, and who stands on the left or right.

Include expressions supported by the scene. A wound needs its visible state and location, not repeated emphasis. Choose details that remain visible at the selected distance instead of listing every recorded trait.

## Format the prompt

For the current Turbo model, a useful default prefix is:

`masterpiece, best quality, score_7,`

Choose the content-rating tag that matches the image: `safe`, `sensitive`, `nsfw`, or `explicit`. State the visible subject count when useful, matching the cast rather than imposing a limit. Add composition and style tags that describe the chosen image.

Tags are lowercase with spaces rather than underscores, except exact `score_*` tags. The documented section order is quality/meta/year/rating, subject count, character, series, artist, then general tags. Order within a section is flexible. Quality tags are optional; a year tag belongs only when deliberately requesting that period's style. An artist tag uses `@artist name` when that style is requested.

Follow the prefix with as many descriptive sentences as the image needs. Keep each person's attributes and action together, then describe shared surroundings and light. Two sentences are a useful starting point, not a ceiling. Pure natural-language prompts should contain at least two descriptive sentences.

Start with unweighted descriptions. Use `(trait:weight)` only to address a known missed detail from a previous attempt; `(trait:2)` is an available emphasis form, not a default for unusual anatomy or size. Describe character relationships in prose rather than inventing scoped tag groups.

## Examples

These demonstrate different compositions, not a fixed cast, style, or reply template. Use the current scene's facts.

Shared action:

masterpiece, best quality, score_7, safe, 3girls, wide shot. On the left, an adult red-haired human in a green cloak holds a lantern above a stone table. At the center, an adult copper-skinned elf with black hair and a gray tunic spreads a map across the table. On the right, an adult dwarf with a braided brown beard and a leather apron points to a mark on the map with her gloved finger. Warm lantern light falls across their hands and the map inside a dark sandstone chamber.

Close detail:

masterpiece, best quality, score_7, safe, 1girl, close-up. An adult elf with copper-brown skin, black hair, and gold-brown eyes peers through a narrow opening in an iron door. Her face fills the frame, with one eye lit by sunlight from the other side and the rough edge of the door in the foreground.

First-person action:

masterpiece, best quality, score_7, safe, 1girl, pov, medium shot. An adult elf with red hair, gold eyes, and a travel cloak reaches toward a clay cup offered by the viewer's brown-skinned right hand in the foreground. Her fingers close around the cup beneath the warm light of a doorway lamp.

Environment:

masterpiece, best quality, score_7, safe, landscape, wide shot. A dry stone aqueduct crosses a sandy ravine, its central arch broken above a heap of fallen blocks. A narrow path descends along the near cliff toward the rubble, while late sunlight illuminates the far wall of the empty ravine.

Reply with the positive image prompt only, within 2,400 characters. No preface, explanation, or negative-prompt section.
