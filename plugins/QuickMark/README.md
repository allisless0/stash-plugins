# QuickMark

Add a scene marker at the current playback position without leaving the player.

## Install

```bash
docker cp QuickMark Stash:/root/.stash/plugins/
```

Settings → Plugins → **Reload Plugins**, then hard-reload the browser tab.

UI-only plugin. No backend.

## Use

Press **M** during playback. The timestamp is captured the instant you press it,
so taking your time over the tag does not move the marker.

| Key | Action |
|---|---|
| `M` | Open the panel |
| `1`-`9` | Add a marker with that recent tag immediately |
| type | Search tags |
| `↑` `↓` | Move through results |
| `Enter` | Add the marker with the highlighted tag |
| `Tab` | Jump to the title field and back |
| `,` `.` | Nudge the timestamp by one second |
| `Esc` | Cancel |

The fastest path is three keystrokes: `M`, a number, done.

The number keys and the timestamp nudge only work while the search box is empty,
so they never interfere with typing a tag name.

## Tags

Stash requires a primary tag on every marker, which is why the panel is built
around tag selection rather than a title.

If your search matches no existing tag exactly, the last row offers to create
one. Select it and QuickMark creates the tag first, then the marker.

Tags you use are remembered in browser local storage and become the numbered
quick picks, most recent first, up to nine.

## Title

Optional. Leave it blank and Stash displays the primary tag name as the marker
label, which is usually what you want.

## Notes

- Clicking outside cancels rather than saving. Creating a marker is deliberate,
  unlike QuickRate where clicking away commits the rating.
- Clicking the video while the panel is open only closes the panel; the click
  is swallowed so playback does not toggle. Control-bar clicks pass through.
- A recent-tag slot that fails (tag renamed or deleted since) is dropped from
  the recents list automatically.
- After creating a marker the plugin refetches the marker queries so the list
  updates without a reload. If Stash does not expose its Apollo client on your
  build, the marker is still saved, it just appears after a refresh.
- Marker preview images are not generated automatically. Stash needs a generate
  task for that, which is core behaviour rather than something a plugin sets.
- `M` is captured only on `/scenes/<id>` pages and ignored while you are typing
  in a field elsewhere on the page.

## Debug

```js
localStorage.setItem("quickMarkDebug", "1");
```

Reload and watch the console.
