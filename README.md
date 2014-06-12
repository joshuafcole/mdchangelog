# mdchangelog [![](https://travis-ci.org/creativelive/mdchangelog.svg)](https://travis-ci.org/creativelive/mdchangelog)

Generate a markdown changelog from git history, linked to github issues and milestones

## Install

Install via `[sudo] npm i -g mdchangelog`

## Usage

Generate a github oauth token and make it available in your `env` at `MDCHANGELOG_TOKEN`

```
Usage: (inside of a git repo)
mdchangelog

By default, mdchangelog will prepend to an existing `CHANGELOG.md`
using the git sha from the *last release entry* in the changelog.
You can override this behaviour by passing a git revision selection:
mdchangelog HEAD...66c248f

Options:
--cwd <path> path to git repo, defaults to $PWD
--regenerate rebuild the entire changelog
--overwrite overwrite CHANGELOG.md in place, instead of prepending (implies regenerate)
--no-prologue disable prologue text
--no-orphan-issues ignore issues without a milestone
--timeout <int> timeout value in ms for github requests
--order-issues <order> order issues by one of [number,opened_at,updated_at,closed_at]
--reverse-issues reverse the order of issues
--order-milestones <order> order issues by one of [number,opened_at,updated_at,title,semver]
--reverse-milestones reverse the ordering of milestones
--remote <github/repo> override git config remote repo to pull issues from
--stdout send output to stdout instead of writing to file (implies regenerate)
```

## Output

Here is an example mdchangelog output for the [hapi](https://github.com/spumko/hapi) git history:
https://gist.github.com/diffsky/532f7ea5fcba2cb1c0d4/8e20af41fd94cd1f642e60f9074013d9ecac25ce
