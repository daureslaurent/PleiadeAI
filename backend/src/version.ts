// Typed, app-wide access to the backend's own build version.
// The numbers live in version.json, which the pre-commit hook (scripts/bump-version.mjs) bumps
// whenever a commit touches `backend/`. Surfaced to the operator via GET /api/host/version and
// shown beside the frontend version in the sidebar ("srv 1.0.x").
//
// build:assets (scripts/copy-assets.js) copies version.json into dist/ so the compiled require()
// resolves at runtime.
import data from './version.json';

export const BACKEND_VERSION: string = data.version;
export const BACKEND_BUILD: number = data.build;
export const BACKEND_DATE: string = data.date;
