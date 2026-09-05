# Third-party notices

UnderstandProof depends on third-party packages and system components. Their licenses
remain with their respective copyright holders.

Generate the exact production JavaScript inventory for the current lockfile:

```bash
pnpm licenses list --prod
```

The current inventory includes MIT, Apache-2.0, ISC, BSD-3-Clause, 0BSD,
LGPL-3.0-or-later and CC-BY-4.0 material. Notable non-permissive data or runtime
components include:

- `@img/sharp-libvips-*`, which distributes libvips runtime components under
  LGPL-3.0-or-later;
- `caniuse-lite` browser-compatibility data under CC-BY-4.0;
- FFmpeg, installed in the runtime image and governed by the license options of
  the Debian package build;
- PostgreSQL, Node.js and Debian packages in their respective container images.

The release pipeline emits an SPDX JSON SBOM for the exact production image.
Review that SBOM and the image package licenses before redistributing a built
image. This file is an inventory aid, not a replacement for the license files
shipped by each dependency.
