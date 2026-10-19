// Read-only overlay for /capture-list and /capture-show (plan task 4.3): scrolls a rendered
// Markdown document and closes on Esc or q. It adds nothing to the transcript.
import { getMarkdownTheme, Markdown, type Theme } from "@oh-my-pi/pi-coding-agent";
import { type Component, matchesKey, type TUI } from "@oh-my-pi/pi-tui";

export class MarkdownPager implements Component {
	readonly #markdown: Markdown;
	#lines: readonly string[] = [];
	#width = -1;
	#offset = 0;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		text: string,
		private readonly close: () => void,
	) {
		this.#markdown = new Markdown(text, 1, 0, getMarkdownTheme());
	}

	#height(): number {
		return Math.max(5, this.tui.terminal.rows - 6);
	}

	render(width: number): readonly string[] {
		if (width !== this.#width) {
			this.#lines = this.#markdown.render(width);
			this.#width = width;
		}
		const height = this.#height();
		this.#offset = Math.min(this.#offset, Math.max(0, this.#lines.length - height));
		const end = Math.min(this.#lines.length, this.#offset + height);
		const position = this.#lines.length > height ? ` · lines ${this.#offset + 1}–${end} of ${this.#lines.length}` : "";
		return [...this.#lines.slice(this.#offset, end), this.theme.fg("muted", ` ↑↓ PgUp PgDn scroll · Esc close${position}`)];
	}

	handleInput(data: string): void {
		const page = this.#height() - 1;
		if (matchesKey(data, "escape") || data === "q") return this.close();
		if (matchesKey(data, "up")) this.#offset = Math.max(0, this.#offset - 1);
		else if (matchesKey(data, "down")) this.#offset += 1;
		else if (matchesKey(data, "pageUp")) this.#offset = Math.max(0, this.#offset - page);
		else if (matchesKey(data, "pageDown") || data === " ") this.#offset += page;
		else return;
		this.tui.requestRender();
	}

	invalidate(): void {
		this.#width = -1;
		this.#markdown.invalidate();
	}
}
