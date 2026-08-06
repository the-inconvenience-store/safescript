# SafeScript

SafeScript is a restricted TypeScript extension language. This glossary defines the terms that distinguish its value and authority model from JavaScript and host application code.

## Language

**Canonical value**:
An immutable, language-neutral SafeScript value that conforms to a declared schema and has no JavaScript object identity.
_Avoid_: JavaScript value, object

**Branded value**:
A canonical primitive value with a nominal SafeScript type that prevents accidental substitution with its underlying primitive or another brand.
_Avoid_: Wrapper object

**Value limits**:
The maximum depth, node count, and encoded size permitted for one canonical value at a SafeScript seam.
_Avoid_: Recursion settings
