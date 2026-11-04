# Stitching fixtures

`chat-0.png` and `chat-1.png` are locally rendered synthetic chat screenshots,
not private chat records. Each is 900 x 719. The second viewport is 144 pixels
below the first, with 575 overlapping rows. The expected image is 900 x 863.
The native test checks every RGBA output pixel, including after revisits.
