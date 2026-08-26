# Skills

Guidance Claude Code loads when working in this repository. Neither is written
here, and neither is committed: they are other people's work under their own
terms, so this file records what they are and how to fetch them rather than
redistributing them inside this one.

```sh
mkdir -p .claude/skills/frontend-design .claude/skills/ux-heuristics

# anthropics/skills — check its LICENSE and THIRD_PARTY_NOTICES.md
curl -o .claude/skills/frontend-design/SKILL.md \
  https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/frontend-design/SKILL.md

# wondelai/skills — check its licence before reusing any of it
curl -o .claude/skills/ux-heuristics/SKILL.md \
  https://raw.githubusercontent.com/wondelai/skills/main/ux-heuristics/SKILL.md
```

## How they were used here

`frontend-design` is written for pages that need a distinctive visual identity
and tells you to take an aesthetic risk. This is a tool, not a landing page, so
the parts that earned their keep were the ones about restraint and about
writing: name things by what the reader controls, let each element do one job,
treat an error or an empty screen as a place to give direction. The instruction
to be bold was deliberately not followed.

`ux-heuristics` applied as written. The rule that shaped the interface most is
recognition over recall, which is why each format states its limits next to the
control that picks it rather than in documentation nobody opens.
