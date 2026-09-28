# guizhan-resources-ci

The build command runs from `build_directory` (relative to the checkout root; default `.`).
Only `.jar` and `.zip` artifacts under that directory's `target/` and `build/libs/`
are collected; sibling projects and other output directories are not scanned.

The build job stages original artifacts and uploads them as a raw, internal handoff.
The finalize job reads those raw files, resolves the version and final filenames,
optionally rewrites JAR metadata versions to the resolved display name, and writes
the final artifacts separately. Sizes and checksums in the manifest are computed
from these final bytes. Only the final artifacts and manifest are published and
reported in the success callback; raw files are never published.

`rewrite_version` defaults to off. When on, signed JARs are rejected rather than
having their signatures removed. Any rewrite, filename validation, or naming
collision failure fails the entire run, even if the build command succeeded;
no partial set of final artifacts is published. An empty `artifact_name_template`
uses `{basename}-{version}` (appends the version without removing any old
version text). The original `.jar` or `.zip` extension, including its case, is
automatically appended after rendering. Custom templates cannot use `{ext}`;
they must include `{version}`, `{channel_seq}`, or `{commit_sha}` and must pass
validation before the run is finalized.
