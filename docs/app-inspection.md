# App Inspection & Code Execution

Discover and interact with debug globals (Apollo Client, Redux stores, Expo Router, etc.) and execute JavaScript expressions directly in your running app.

## Discover Debug Globals

Find what debugging objects are available in your app:

```
list_debug_globals
```

Example output:

```json
{
    "Apollo Client": ["__APOLLO_CLIENT__"],
    "Redux": ["__REDUX_STORE__"],
    "Expo": ["__EXPO_ROUTER__"],
    "Reanimated": ["__reanimatedModuleProxy"]
}
```

## Inspect an Object

Before calling methods on an unfamiliar object, inspect it to see what's callable:

```
inspect_global with objectName="__EXPO_ROUTER__"
```

Example output:

```json
{
    "navigate": { "type": "function", "callable": true },
    "push": { "type": "function", "callable": true },
    "currentPath": { "type": "string", "callable": false, "value": "/" },
    "routes": { "type": "array", "callable": false }
}
```

## Execute Code in App

Run simple JavaScript expressions using globals discovered via `list_debug_globals`:

```
execute_in_app with expression="__DEV__"
// Returns: true

execute_in_app with expression="__APOLLO_CLIENT__.cache.extract()"
// Returns: Full Apollo cache contents

execute_in_app with expression="__EXPO_ROUTER__.navigate('/settings')"
// Navigates the app to /settings
```

**Limitations (Hermes engine):**
- No `require()` or `import` — only pre-existing globals are available
- No `async/await` syntax — use simple expressions or promise chains (`.then()`)
- No emoji or non-ASCII characters in string literals — causes parse errors
- Keep expressions simple and synchronous when possible
