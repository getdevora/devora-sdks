# Contributing

Please open an issue before substantial changes. This repository is a reviewed public mirror. Contributions are incorporated into the development source and exported back here; do not independently change package versions or generated metadata.

Use Bun 1.3.14 and Node 22. Set `DEVORA_SDK_API_ORIGIN` to an HTTPS API origin and `DEVORA_SDK_DASHBOARD_ORIGIN` to your dashboard origin. Run `bun install --frozen-lockfile`, `bun run check-types:sdks`, `bun run test:sdks` and `bun run test:python-sdks`. No private platform services are required for unit tests.

Public package releases are coordinated across npm and PyPI. A version tag is subject to backend compatibility verification and explicit release approval. Never add credentials to source, issues or pull requests.
