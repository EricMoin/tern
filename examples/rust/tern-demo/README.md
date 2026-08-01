# tern-demo

Example binary driving the tern TUI renderer end to end.

It builds a scene tree — a flex-column [`Box`] with a rounded border and
1-cell padding holding two [`Text`] lines — enters raw mode through
`tern-terminal`, and runs an event loop on the alternate screen. Every frame
is painted by the `tern-components` compositor, diffed against the previous
frame, and flushed through the terminal backend. Pressing `q` (or Ctrl+C)
quits; resizing the terminal clears the stale frame and repaints.

## Running

The demo needs a real terminal: it enters raw mode and paints the alternate
screen, so it must run inside a TTY (not a plain pipe).

```sh
cargo run -p tern-demo
```

## PTY smoke test

To verify the demo renders and quits on `q` non-interactively, run it inside
a pseudo-terminal with `q` piped in as input:

```sh
printf 'q' | script -q /dev/null cargo run -p tern-demo
```

Expected: the demo paints a frame (escape sequences go to `/dev/null`) and
exits with status 0 after reading the `q` key.
