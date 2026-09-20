// Some tests assume a temp directory is a *plain* directory: no `.git` in it or
// in any ancestor. That holds under a normal TMPDIR, but not when TMPDIR itself
// sits inside a git checkout (some CI layouts), where the implementation is
// right and the assumption is what fails. Those tests skip themselves instead.

import fs from "node:fs";
import path from "node:path";

/** True when `dir` or any ancestor has a `.git` entry. */
export function hasGitAncestor(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      fs.lstatSync(path.join(current, ".git"));
      return true;
    } catch {
      /* none here */
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
