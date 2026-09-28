// css-tree exposes these runtime entry points; its upstream types currently
// describe only the root. Reuse those exact signatures without bundling the
// full validation lexer and its grammar tables into the recording SDK.
declare module "css-tree/parser" {
	import { parse } from "css-tree"
	export default parse
}
declare module "css-tree/generator" {
	import { generate } from "css-tree"
	export default generate
}
declare module "css-tree/walker" {
	import { walk } from "css-tree"
	export default walk
}
declare module "css-tree/utils" {
	export { ident } from "css-tree"
}
