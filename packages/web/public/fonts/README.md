# Self-hosted brand fonts

Declared by `DESIGN.md` and the `@font-face` rules in `src/styles/tokens.css`.
Both families are licensed under the SIL Open Font License 1.1 (`OFL-1.1.txt`),
which allows self-hosting and redistribution. The upstream license files, with
their copyright notices, ship next to the fonts.

| File | Family / weight | Upstream source | License file |
|---|---|---|---|
| `IBMPlexSans-Regular.woff2` | IBM Plex Sans 400 | `@ibm/plex-sans@1.1.0`, `fonts/split/woff2/IBMPlexSans-Regular-Latin1.woff2` | `LICENSE-IBMPlexSans.txt` |
| `IBMPlexSans-Medium.woff2` | IBM Plex Sans 500 | `@ibm/plex-sans@1.1.0`, `fonts/split/woff2/IBMPlexSans-Medium-Latin1.woff2` | `LICENSE-IBMPlexSans.txt` |
| `IBMPlexSans-SemiBold.woff2` | IBM Plex Sans 600 | `@ibm/plex-sans@1.1.0`, `fonts/split/woff2/IBMPlexSans-SemiBold-Latin1.woff2` | `LICENSE-IBMPlexSans.txt` |
| `SpaceGrotesk-Medium.woff2` | Space Grotesk 500 | Space Grotesk `2.0.0`, `ttf/static/SpaceGrotesk-Medium.ttf`, Latin1 subset | `LICENSE-SpaceGrotesk.txt` |
| `SpaceGrotesk-SemiBold.woff2` | Space Grotesk 600 | Space Grotesk `2.0.0`, `ttf/SpaceGrotesk[wght].ttf` instanced at `wght=600`, Latin1 subset | `LICENSE-SpaceGrotesk.txt` |

## Sources

- IBM Plex Sans: <https://github.com/IBM/plex/releases/tag/%40ibm%2Fplex-sans%401.1.0>,
  asset `ibm-plex-sans.zip` (sha256 `fb365d910566e6d199cc2c15579a7dd9a267128e18431a394ed81f1970c69200`).
  The files are IBM's Latin1 split, copied unmodified and renamed.
  "Plex" is a Reserved Font Name, so these files must not be modified.
- Space Grotesk: <https://github.com/floriankarsten/space-grotesk/releases/tag/2.0.0>,
  asset `SpaceGrotesk-2.0.0.zip` (sha256 `53b415577d4139248555300710bea0d268c7a5be67b93de53b716a9736cabffd`).
  The release has no static SemiBold, so 600 is instanced from the variable font.
  Space Grotesk declares no Reserved Font Name.

## Rebuilding Space Grotesk

Run from the extracted `SpaceGrotesk-2.0.0/` folder, with `fonttools==4.68.0` and `brotli==1.2.1`
(for example in a `python:3.13-slim` container). The unicode range matches IBM's Latin1 split, so
both families cover the same characters.

```sh
RANGE="U+0000,U+000D,U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2013-2014,U+2018-201A,U+201C-201E,U+2020-2022,U+2026,U+2030,U+2039-203A,U+2044,U+20AC,U+2122,U+2212,U+FB01-FB02"
fonttools varLib.instancer 'ttf/SpaceGrotesk[wght].ttf' wght=600 --static -o SpaceGrotesk-SemiBold.ttf
# Then set OS/2.usWeightClass = 600 and name IDs 1/2/3/4/6/16/17 to "Space Grotesk SemiBold"
# (the variable font's STAT table has no 600 entry, so --update-name-table fails).
pyftsubset ttf/static/SpaceGrotesk-Medium.ttf --unicodes="$RANGE" --layout-features='*' --flavor=woff2 --output-file=SpaceGrotesk-Medium.woff2
pyftsubset SpaceGrotesk-SemiBold.ttf --unicodes="$RANGE" --layout-features='*' --flavor=woff2 --output-file=SpaceGrotesk-SemiBold.woff2
```
