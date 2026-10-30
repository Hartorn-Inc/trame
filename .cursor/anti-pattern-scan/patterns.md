# Anti-Pattern Detection Catalog

Each pattern has: ID, description, severity, detection query, false-positive guidance, and fix.

---

## Frontend Patterns

### F1 — Client-side full data load

**Severity**: CRITICAL
**Why**: Loads all rows into the browser, then paginates client-side. Breaks when entities grow.

**Detect**:
```
Grep: pattern="useDataTable|useQuerySyncDataTable" glob="frontend/src/**/*.{ts,tsx}"
```

**Validate**: Check if the entity is bounded (e.g., a small config list → false positive) or unbounded (evaluations, test cases, tasks → real finding). Ignore test files.

**Fix**: Migrate to `useServerDataTable` / `useServerDataTableQuery` with backend search endpoint.

---

### F2 — Export buffered in memory

**Severity**: WARNING
**Why**: Pulling an entire export into SPA memory before offering a download stalls the tab and can OOM.

**Detect**:
```
Grep: pattern="await.*(fetch|apiFetch|baseFetch).*export|\.blob\(\)|arrayBuffer\(\)" glob="frontend/src/**/*.{ts,tsx}"
```

**Validate**: Check if the response body is fully consumed then turned into an object URL. Direct navigation (`window.open('/_api/...')` or `<a href>`) is fine.

**Fix**: Let the browser download from `/_api/...` (anchor or `window.open`), do not `await` the full body in JS.

---

### F3 — Sequential independent queries

**Severity**: WARNING
**Why**: Independent `useApiQuery` / `useQuery` calls that wait on each other (or a parent `await`) delay first paint.

**Detect**:
```
Grep: pattern="useApiQuery\(" glob="frontend/src/app/**/*.{ts,tsx}"
```
Flag pages that `await` fetchers, or that skip `enabled` for query B until query A returns when B does not need A's data.

**Validate**: If the second query needs an id from the first, that is a real dependency. Parallel queries with separate keys are correct.

**Fix**: Run independent queries in parallel. Use `enabled` only when a real input is missing.

---

### F4 — Leftover `'use client'` / `'use server'`

**Severity**: INFO
**Why**: The app is a Vite SPA. These directives are no-ops and signal leftover Next.js structure.

**Detect**:
```
Grep: pattern="^[\"']use (client|server)[\"']" glob="frontend/src/**/*.{ts,tsx}" output_mode="files_with_matches"
```

**Validate**: Do not add new ones. Flag new additions as MUST FIX; existing leftovers are cleanup.

**Fix**: Delete the directive. Do not split "server" vs "client" components.

---

### F5 — Missing loading UI for queries

**Severity**: INFO
**Why**: `useApiQuery` returns `undefined` while loading. Pages that assume data is present flash empty or throw.

**Detect**:
```
Grep: pattern="useApiQuery\(" glob="frontend/src/app/**/*.{ts,tsx}" output_mode="files_with_matches"
```
Then check that the component renders `Skeleton` (or equivalent) when the query result is undefined.

**Validate**: A child that only mounts after a parent has data is fine.

**Fix**: `if (!data) return <Skeleton ... />` (or page-level skeleton) before using the value.

---

### F6 — Client-side sorting/filtering on server-backed tables

**Severity**: WARNING
**Why**: Data is fetched from the server but sorted/filtered in the browser — defeats server pagination.

**Detect**:
```
Grep: pattern="manualPagination:\s*false|manualSorting:\s*false" glob="frontend/src/**/*.{ts,tsx}"
```
Also check for tables using `useServerDataTable` but with manual flags disabled.

**Validate**: Small, bounded datasets (< 100 rows) are fine with client-side sorting.

**Fix**: Set `manualPagination: true` and `manualSorting: true`, ensure the backend search endpoint supports sort params.

---

### F7 — Missing route error components

**Severity**: INFO
**Why**: Routes without `errorComponent` bubble to the router default and can replace the whole shell.

**Detect**:
```
Grep: pattern="errorComponent" glob="frontend/src/routes/**/*.tsx"
```
Compare with `createFileRoute` files that have no `errorComponent` and are not covered by a parent layout `errorComponent`.

**Validate**: Nested routes may use `defaultErrorComponent` from `frontend/src/router.tsx`. Flag new route trees that swallow errors with no UI.

**Fix**: Set `errorComponent` on the layout or route, or rely on the router default (`DefaultErrorPage`).

---

### F8 — Fetching full objects when only metadata needed

**Severity**: INFO
**Why**: API calls return full entities (with large fields like prompts, datasets) when only name/id/status is displayed.

**Detect**: Manual — look at list pages and check which fields from the fetched object are actually rendered. Compare the API response shape (from backend router) with the JSX.

**Validate**: If the backend already has a lightweight list endpoint, the frontend should use it.

**Fix**: Create a dedicated lightweight list DTO on the backend, or use field selection if the API supports it.

---

## Backend Patterns

### B1 — N+1 query loop

**Severity**: CRITICAL
**Why**: Issues one query per item in a list, causing O(N) database round-trips.

**Detect**:
```
Grep: pattern="for .+ in .+:" glob="backend/src/backend/{services,repositories}/**/*.py"
```
Then check if any `await.*execute(select` or `await.*get_by` appears inside the loop body.

Also specifically check for known instances:
```
Grep: pattern="_remap_metric_name" glob="backend/src/backend/**/*.py"
```

**Validate**: Loops over small fixed-size collections (e.g., enum values) are false positives. Only flag loops over query results or user-supplied lists.

**Fix**: Use `WHERE col IN (...)` with a single query, or join in SQL.

---

### B2 — Unbounded SELECT without LIMIT

**Severity**: WARNING
**Why**: Fetching all rows from a table that can grow unbounded risks OOM and slow responses.

**Detect**:
```
Grep: pattern="select\(.*\)\.where" glob="backend/src/backend/repositories/**/*.py"
```
Then check if the query chain includes `.limit(`. Exclude queries that go through `search_helper.build_queries` (already paginated).

**Validate**: Queries filtered by a unique FK with known small cardinality (e.g., "checks for one evaluation") are acceptable. Flag queries on large tables (test_cases, evaluations, datasets) without limits.

**Fix**: Add `.limit()` or route through the search_helper pagination.

---

### B3 — Python-side aggregation

**Severity**: WARNING
**Why**: Fetching rows then computing sum/avg/group in Python instead of SQL wastes memory and bandwidth.

**Detect**:
```
Grep: pattern="sum\(.*for.*in|len\(.*\.all\(\)|Counter\(|groupby\(" glob="backend/src/backend/{services,repositories}/**/*.py"
```

**Validate**: Aggregations on small in-memory collections (< 50 items, already fetched for other reasons) are fine.

**Fix**: Use SQL `func.count()`, `func.sum()`, `GROUP BY`, window functions.

---

### B4 — SELECT * when few columns needed

**Severity**: INFO
**Why**: Loads all columns (including large text/JSON) when only a few are used.

**Detect**:
```
Grep: pattern="select\(\w+Table\)" glob="backend/src/backend/repositories/**/*.py"
```
Then check the calling code to see how many fields are actually accessed from the result.

**Validate**: If the full object is returned to the API layer and serialized, selecting all columns is fine. Flag cases where only `.id` or `.name` is extracted.

**Fix**: Use `select(Table.id, Table.name)` for specific columns.

---

### B5 — Blocking sync work in async context

**Severity**: CRITICAL
**Why**: CPU-bound or blocking I/O in an async handler blocks the event loop, stalling all concurrent requests.

**Detect**:
```
Grep: pattern="import (pandas|numpy|sklearn|umap|hdbscan|cv2|PIL)" glob="backend/src/backend/{services,handlers,http}/**/*.py"
```
Then check if these are used inside `async def` functions without `run_in_executor`.

Also:
```
Grep: pattern="time\.sleep|open\(" glob="backend/src/backend/{services,handlers,http}/**/*.py"
```

**Validate**: Imports in type-checking blocks (`if TYPE_CHECKING`) are false positives. Usage inside sync helper functions called by the worker (not the API) is acceptable.

**Fix**: Wrap in `asyncio.get_event_loop().run_in_executor(None, sync_func)` or move to worker jobs.

---

### B6 — Business logic in HTTP routers

**Severity**: WARNING
**Why**: Violates clean architecture — routers should only parse requests and delegate to services.

**Detect**:
```
Grep: pattern="select\(|insert\(|update\(|delete\(" glob="backend/src/backend/http/**/*.py"
```
Also:
```
Grep: pattern="(if|for|while).*:" glob="backend/src/backend/http/**/*.py"
```
Flag conditional logic beyond simple input validation.

**Validate**: Simple `if not x: raise HTTPException` is fine (input validation). Flag multi-step orchestration, loops, or direct repository calls.

**Fix**: Move logic to a service method; router calls service.

---

### B7 — Swallowed exceptions

**Severity**: WARNING
**Why**: `except: pass` or `except: log()` hides failures, making bugs invisible.

**Detect**:
```
Grep: pattern="except.*:\s*$" glob="backend/src/backend/**/*.py" -A=3
```
Check if the except body is only `pass`, `continue`, or a bare `logger` call without re-raise.

Also:
```
Grep: pattern="except.*(Exception|BaseException).*:" glob="backend/src/backend/**/*.py" -A=3
```

**Validate**: `except SomeSpecificError` with logging is often fine. Flag broad `except Exception` with no re-raise.

**Fix**: Either re-raise, raise a domain-specific exception, or narrow the except clause.

---

### B8 — DB connection held during external I/O

**Severity**: WARNING
**Why**: Holding a DB connection while waiting on HTTP calls or file I/O starves the connection pool.

**Detect**:
```
Grep: pattern="(httpx|aiohttp|requests)\.(get|post|put|patch|delete)" glob="backend/src/backend/services/**/*.py"
```
Then check if any DB operations (`get_db`, `execute`, `db_commit`) occur in the same function, before and after the HTTP call.

**Validate**: If `db_release()` is called before the HTTP call and `get_db()` after, it's fine. Flag when the connection spans the I/O gap.

**Fix**: Call `db_release()` before external I/O, re-acquire after. Or restructure: DB read → release → external call → re-acquire → DB write.

---

## Cross-Cutting Patterns

### X1 — Unbounded list API endpoints

**Severity**: WARNING
**Why**: Endpoints that return all items without pagination support.

**Detect**:
```
Grep: pattern="async def (list_|get_all)" glob="backend/src/backend/http/**/*.py"
```
Check if the handler accepts `limit`/`offset` or `SearchCriteria` params.

**Validate**: Endpoints returning small bounded sets (e.g., list of enum values, project settings) are fine.

**Fix**: Add `SearchCriteria` parameter and route through `search_helper`.
