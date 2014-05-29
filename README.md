# mdchangelog

Generate a markdown changelog from git history, linked to github issues and milestones

## Install

Install via `[sudo] npm i -g mdchangelog`

## Usage

Generate a github oauth token and make it available in your `env` at `MDCHANGELOG_TOKEN`

Inside of a git repo, run: `mdchangelog`

By default, mdchangelog will prepend to an existing `CHANGELOG.md` using the git sha from the
last release entry in the file. You can override this behaviour by passing a git
revision selection:

```
mdchangelog HEAD...66c248f
```

mdchangelog supports the following flags:
- `--overwrite` overwrite CHANGELOG.md instead of prepending
- `--no-prologue` disables prologue text
- `--no-orphan-issues` ignore issues without a milestone
- `--timeout` <int> timeout value in ms for github requests



## Output

Here is an example mdchangelog output for the [hapi](https://github.com/spumko/hapi) git history:
https://gist.github.com/diffsky/532f7ea5fcba2cb1c0d4/8e20af41fd94cd1f642e60f9074013d9ecac25ce
