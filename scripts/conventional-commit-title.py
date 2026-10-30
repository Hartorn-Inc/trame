"""
Is this title a conventional commit?

A pull request squash-merges as its title. Direct pushes to `dev` and `main`
are blocked, so that title is the commit that lands. It has to be
`type(scope)?: description` (feat, fix, docs, style, refactor, perf, test,
chore, ci, build, revert; an optional lowercase scope; an optional `!` for a
breaking change). Renovate's dependency pull requests are `chore(deps): …`.

Reads the title from the first argument, or from TITLE. Exits 0 when it
matches, 1 with a short reason when it does not. No network.

    python3 scripts/conventional-commit-title.py 'feat: add maps'
    TITLE='feat: add maps' python3 scripts/conventional-commit-title.py
"""

import os
import re
import sys

PATTERN = re.compile(
    r'^(feat|fix|docs|style|refactor|perf|test|chore|ci|build|revert)'
    r'(\([a-z0-9/-]+\))?(!)?: .+'
)


def main(argv=None, env=None):
    argv = sys.argv if argv is None else argv
    env = os.environ if env is None else env
    if len(argv) > 1:
        title = argv[1]
    elif 'TITLE' in env:
        title = env['TITLE']
    else:
        print('no title: pass one as the first argument or in TITLE', file=sys.stderr)
        return 1
    if PATTERN.fullmatch(title):
        return 0
    print(f'not a conventional commit title: {title!r}', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
