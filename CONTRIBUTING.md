# Contributing to node-core-mcp

* [Code of Conduct](#code-of-conduct)
* [Setup](#setup)
* [Running tests](#running-tests)
* [Adding a tool](#adding-a-tool)
* [Developer's Certificate of Origin 1.1](#developers-certificate-of-origin)

## Setup

```bash
git clone --recurse-submodules https://github.com/nicolo-ribaudo/node-core-mcp
cd node-core-mcp
npm run setup   # initializes the node submodule and builds the dev binary
```

`npm run setup` runs `./configure --without-intl && make -j4 node` inside the `node/` submodule. The full build takes several minutes.

## Running tests

```bash
npm test
```

All tests are in `bin/node-core-mcp.test.mjs`, `lib/server.test.mjs`, and `lib/tools.test.mjs`. They require the dev binary (`node/node`) to be present — run `npm run setup` first.

## Adding a tool

Tools are registered in `lib/tools.mjs` via `server.tool(name, description, schema, handler)`.

1. Add your tool inside `registerTools()` following the existing pattern.
2. Add it to the expected list in `lib/tools.test.mjs` (`tools/list` test).
3. Add a test for the new tool's behavior.

## Code of Conduct

The Node.js project has a
[Code of Conduct](https://github.com/nodejs/admin/blob/HEAD/CODE_OF_CONDUCT.md)
to which all contributors must adhere.

<a id="developers-certificate-of-origin"></a>

## Developer's Certificate of Origin 1.1

<pre>
By making a contribution to this project, I certify that:

 (a) The contribution was created in whole or in part by me and I
     have the right to submit it under the open source license
     indicated in the file; or

 (b) The contribution is based upon previous work that, to the best
     of my knowledge, is covered under an appropriate open source
     license and I have the right under that license to submit that
     work with modifications, whether created in whole or in part
     by me, under the same open source license (unless I am
     permitted to submit under a different license), as indicated
     in the file; or

 (c) The contribution was provided directly to me by some other
     person who certified (a), (b) or (c) and I have not modified
     it.

 (d) I understand and agree that this project and the contribution
     are public and that a record of the contribution (including all
     personal information I submit with it, including my sign-off) is
     maintained indefinitely and may be redistributed consistent with
     this project or the open source license(s) involved.
</pre>
