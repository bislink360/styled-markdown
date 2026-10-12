// Which release tag release-check.mjs compares the working tree with.

const semver = (v) => v.replace(/^v/, '').split('.').map(Number);

/** Orders `vX.Y.Z` tags (or bare versions) by version. */
export function cmpSemver(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** The `vX.Y.Z` tags among `names`, oldest first. */
export function releaseTags(names) {
  return names.filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).sort(cmpSemver);
}

/**
 * The tag to compare with, and whether the tree being checked is that of its own release.
 *
 * Normally the base is the newest release tag. But the tracking PR (release/vX.Y.Z → main) is checked again after
 * vX.Y.Z is tagged; the newest tag is then the release itself, and comparing 1.7.0 with v1.7.0 can only fail
 * ("not greater than the last release"). When the tag of the working tree's own version exists and has the same
 * tree, the release is done: compare with the release before it. A tag of the same version with a different tree
 * is a real mistake (the version was not bumped, or the tag is on another commit), so it stays the base and the
 * version check fails.
 *
 * @param {{ tags: string[], version: string, explicit?: string, sameTree: (tag: string) => boolean }} input
 *   `tags`: release tags, oldest first; `version`: the working tree's version; `explicit`: --base;
 *   `sameTree`: whether a tag's tree equals the tree being checked.
 * @returns {{ base: string | undefined, released: boolean }}
 */
export function pickBaseTag({ tags, version, explicit, sameTree }) {
  if (explicit) return { base: explicit, released: false };
  const own = `v${version}`;
  const at = tags.indexOf(own);
  if (at >= 0 && sameTree(own)) return { base: tags[at - 1], released: true };
  return { base: tags.at(-1), released: false };
}
