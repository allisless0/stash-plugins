# Todo

A simple task list for Stash, behind a **Todo** button in the top bar.

- **Add:** open the list, type, press Enter.
- **Link to a page:** on a scene, performer, studio, tag, gallery or group page,
  new tasks are linked to that page (untick "Link to this ..." to skip it). The
  link opens the page, and while you are on it its tasks are listed first and
  the Todo button is outlined.
- **Done:** tick the box. Done tasks fold away under "Done"; **show** lists them,
  **clear** deletes them.
- **Edit:** click a task's text. Enter saves, Esc cancels.
- **Reorder:** drag open tasks.
- **Delete:** the &times; on the right of a task.

The number on the button is how many tasks are still open.

## Where the list lives

In this plugin's Stash config, not the browser. The list is the same on every
device and browser, and clearing site data does not lose it. Open tabs pick up
changes from other devices when the list is opened, when the window gets focus,
and every 30 seconds.

Changes are saved as single operations (add this, tick that) applied to the
list as Stash has it at that moment, so two devices editing at once both keep
their changes.

If the saved list ever cannot be read, the plugin shows a warning and changes
nothing until it is fixed, rather than overwriting it.
