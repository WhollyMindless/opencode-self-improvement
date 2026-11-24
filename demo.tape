# Regenerate the README GIF: vhs demo.tape
# Scripted model turns, real OpenCode host, real plugin, real isolated store.
Output docs/assets/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1000
Set Height 420
Set Framerate 30
Set TypingSpeed 0.05
Set PlaybackSpeed 1.35
Require bun
Require opencode

Type "bun scripts/demo.ts"
Enter
Wait+Screen@20s /no config reads/
Sleep 2s
