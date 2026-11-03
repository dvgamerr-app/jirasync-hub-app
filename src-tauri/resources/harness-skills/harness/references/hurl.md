# Hurl reference (Hurl 8.x)

Source: hurl.dev docs (hurl-file, request, response, capturing-response, asserting-response,
templates, running-tests, manual). Checked against `hurl 8.0.1`.

## File structure

A `.hurl` file is UTF-8 (no BOM) and holds one or more **entries**. Each entry is a request
plus an optional response spec. Entries run in order and share captured variables.

```hurl
# comment
GET {{base_url}}/api/dogs?id=4567
User-Agent: harness                 # headers go right after the request line
[Options]
retry: 3
[Query]
order: newest                       # values are not URL-encoded for you
[BasicAuth]
alice: {{password}}
[Cookies]
theme: light
[Form]                              # or [Multipart]
name: John Doe
HTTP 200
[Captures]
id: jsonpath "$.id"
[Asserts]
jsonpath "$.name" == "Ralphy"
```

- Request sections: `[Options]`, `[Query]`, `[Form]`, `[Multipart]`, `[Cookies]`, `[BasicAuth]`.
  Order does not matter. (`[QueryStringParams]` is also accepted as an older alias.)
- A body goes last in the request, with no marker. If both `[Form]` and a body exist, the body wins.
- Response sections: `[Captures]`, `[Asserts]`.
- Use `\#` inside a value to keep a literal `#`.

## Request bodies

```hurl
POST {{base_url}}/api/dogs
{ "name": "{{dog_name}}", "age": 3 }     # JSON, sets Content-Type: application/json
```

````hurl
POST {{base_url}}/graphql
```graphql
query Hero($episode: Episode) { hero(episode: $episode) { name } }

variables {
  "episode": "JEDI"
}
```
````

- Multiline: a fenced block with an optional language `json`, `xml`, `graphql`, or `raw`
  (`raw` turns off `{{templates}}`).
- One line: `` `Hello world!` ``
- File: `file,payload.json;` (path relative to the `.hurl` file, no `..`)
- Base64 `base64,TG9y...;` and hex `hex,636166;`
- Multipart file field: `avatar: file,avatar.png; image/png`

## Response spec

```hurl
HTTP 200          # status only
HTTP/2 200        # also checks the HTTP version
HTTP *            # any status; use it when [Asserts] checks the status
Content-Type: application/json; charset=utf-8   # implicit header assert
```

## Queries (for captures and asserts)

| Query | Meaning |
| --- | --- |
| `status`, `version` | status code, HTTP version |
| `header "Name"` | response header |
| `cookie "NAME"`, `cookie "NAME[Expires]"` | response cookie or one of its attributes |
| `body`, `bytes`, `sha256`, `md5` | body as text, bytes, or hash |
| `jsonpath "$.items[0].id"` | JSONPath (RFC 9535); a single match becomes a scalar |
| `xpath "//h1"` | XPath 1.0 on HTML/XML |
| `regex "id:([0-9]+)"` | first capture group |
| `url`, `redirects`, `ip`, `duration` | final URL, redirect list, peer IP, time in ms |
| `variable "name"` | an earlier variable |

Captures: `name: <query> [filter]`, e.g. `token: header "X-Token" redact`.

## Predicates

`==` `!=` `>` `>=` `<` `<=` `startsWith` `endsWith` `contains` `matches` `exists`
`isBoolean` `isEmpty` `isFloat` `isInteger` `isIsoDate` `isList` `isNumber` `isObject`
`isString` `isUuid` `isIpv4` `isIpv6`. Put `not` in front to negate them (`not contains`).

```hurl
[Asserts]
status < 300
header "Location" contains "login"
jsonpath "$.items" count == 3
jsonpath "$.id" isInteger
jsonpath "$.id" != null
jsonpath "$.date" matches /^\d{4}-\d{2}-\d{2}$/
jsonpath "$.count" == {{expected}}      # number compare
jsonpath "$.label" == "{{expected}}"    # string compare
body contains "Welcome"
duration < 1000
```

- `"true"` is a string and `true` is a boolean.
- `matches` only works on strings. `contains` works on strings, bytes and lists.
- Filters such as `count`, `nth 0`, `split ","`, `toDate "%Y-%m-%d"` and `daysAfterNow` go between the query and the predicate.

## Variables

- `{{name}}` anywhere templating is allowed. Captures become variables for later entries.
- Built-ins: `{{newUuid}}`, `{{newDate}}`.
- The harness passes `base_url`. The owner can also pass other variables or secrets. Never
  hard-code a value from `.env`.
- Per-entry: `[Options]` → `variable: user=ada`.

## Per-request `[Options]`

`retry: 10` + `retry-interval: 500ms` (poll until asserts pass, e.g. waiting for a job),
`delay: 1s`, `max-time: 10s`, `location: true` (follow redirects), `skip: true`,
`header: X-Debug: 1`, `insecure: true`, `http1.1: true`.

## How the harness runs your files and how to read the result

The app runs `hurl --test --variable base_url=... --report-json <dir> <files>`, so responses
are not printed. On a failure the result shows the failing entry, line, and the expected and
actual values.

| Exit code | Meaning |
| --- | --- |
| 0 | all asserts passed |
| 1 | CLI option error (report this, it is a harness problem) |
| 2 | `.hurl` file parse error: fix your file |
| 3 | runtime error, e.g. cannot connect: is `dev` started? |
| 4 | assert failed: fix the code or the expectation |
