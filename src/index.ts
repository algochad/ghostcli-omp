/**
 * GhostCLI provider extension for omp.
 *
 * Registers `ghostcli` as a first-class provider backed by the GhostCLI router
 * (OpenAI-compatible wire at https://ghostcli.dev/v1):
 *
 * - `/login ghostcli` prompts for an API key, validates it with a minimal
 *   chat completion, and stores it in the auth store. Run it once per key:
 *   every stored credential participates in omp's multi-account
 *   selection/rotation, so usage-limit hits rotate to a sibling key
 *   automatically. (The GET /v1/models listing is public, so unlike nexum it
 *   cannot be used for key validation — a POST /v1/chat/completions probe is
 *   used instead.)
 * - No `GHOSTCLI_API_KEY` env fallback: extension providers cannot register
 *   one (see the `authHeader` note below), so authenticate with
 *   `/login ghostcli`.
 * - Model list is discovered live from GET /v1/models (24 h model cache,
 *   refreshed with `omp models refresh`). The listing is public, so discovery
 *   works even before logging in.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PROVIDER_ID = "ghostcli";
const BASE_URL = "https://ghostcli.dev/v1";
const DEFAULT_MAX_TOKENS = 16000;
const FALLBACK_CONTEXT_WINDOW = 200_000;
/** Cheapest known-good model, used for the login validation probe. */
const VALIDATION_MODEL = "claude-sonnet-5";

interface GhostModelEntry {
	slug?: unknown;
	model?: unknown;
	display_name?: unknown;
	supported_in_api?: unknown;
	context_window?: unknown;
	max_context_window?: unknown;
	input_modalities?: unknown;
}

/** Model contract registered with omp for one GhostCLI model. */
export interface GhostModelConfig {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

async function fetchGhostModels(apiKey: string | undefined): Promise<GhostModelEntry[]> {
	const headers: Record<string, string> = {};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const response = await fetch(`${BASE_URL}/models`, { headers });
	if (!response.ok) {
		throw new Error(`GhostCLI router rejected the request (HTTP ${response.status})`);
	}
	const payload = (await response.json()) as { models?: unknown; data?: unknown };
	const list = Array.isArray(payload.models) ? payload.models : payload.data;
	if (!Array.isArray(list)) {
		throw new Error("GhostCLI router returned an unexpected /v1/models payload");
	}
	return list.filter((entry): entry is GhostModelEntry => entry !== null && typeof entry === "object");
}

/**
 * Validate a key with a minimal chat completion. The /v1/models listing is
 * public (200 even with a bad key), so only a real inference call proves the
 * key works. Uses max_tokens: 1 on the cheapest Claude model.
 */
async function validateApiKey(apiKey: string): Promise<void> {
	const response = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: JSON.stringify({
			model: VALIDATION_MODEL,
			messages: [{ role: "user", content: "ok" }],
			max_tokens: 1,
		}),
	});
	if (response.status === 401) {
		throw new Error("GhostCLI router rejected the key (HTTP 401 — invalid or revoked API key)");
	}
	if (!response.ok) {
		throw new Error(`GhostCLI router rejected the request (HTTP ${response.status})`);
	}
}

/** Map a router entry to the omp model contract, or null when unusable. */
function toModelConfig(entry: GhostModelEntry): GhostModelConfig | null {
	if (entry.supported_in_api === false) return null;
	// The router may list display variants of one model (e.g. "z-ai/glm-5.3"
	// and "z-ai/glm-5.3[1m]" share model "z-ai/glm-5.3"); the `model` field is
	// the request string, so it is the canonical id.
	const modelField = typeof entry.model === "string" ? entry.model.trim() : "";
	const slugField = typeof entry.slug === "string" ? entry.slug.trim() : "";
	const id = modelField.length > 0 ? modelField : slugField.length > 0 ? slugField : undefined;
	if (!id) return null;
	const displayField = typeof entry.display_name === "string" ? entry.display_name.trim() : "";
	const contextCandidates = [entry.context_window, entry.max_context_window];
	let contextWindow = FALLBACK_CONTEXT_WINDOW;
	for (const candidate of contextCandidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
			contextWindow = candidate;
			break;
		}
	}
	const modalities = Array.isArray(entry.input_modalities) ? entry.input_modalities : [];
	return {
		id,
		name: displayField.length > 0 ? displayField : id,
		reasoning: true,
		input: modalities.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

export default function ghostcliProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: BASE_URL,
		api: "openai-completions",
		// No `apiKey` here on purpose. `apiKey` is registered as a *config
		// override*, which outranks stored credentials in the auth cascade
		// (runtime > config > OAuth > login key > env > stored key), so setting
		// it to "GHOSTCLI_API_KEY" pinned every request to that one env key,
		// killed multi-key rotation, and 401'd with the literal string when the
		// env var was unset. `ProviderConfig` has no `envKeys` field, so an
		// extension-registered provider cannot get a real env fallback; leaving
		// it unset lets the cascade reach the `/login` credentials in the store,
		// which is what enables session stickiness, cross-session round-robin,
		// and automatic rotation to a sibling key on usage-limit hits.
		authHeader: true,
		oauth: {
			name: "GhostCLI",
			async login(callbacks) {
				callbacks.onProgress?.("Paste a GhostCLI API key (gcli_…)");
				const raw = await callbacks.onPrompt({
					message: "GhostCLI API key",
					placeholder: "gcli_…",
					secret: true,
				});
				const apiKey = raw.trim();
				if (!apiKey) throw new Error("No API key provided");
				callbacks.onProgress?.("Validating key with a minimal chat completion…");
				await validateApiKey(apiKey);
				callbacks.onProgress?.("Key accepted");
				return apiKey;
			},
		},
		// Static fallback so `omp models ghostcli` lists the known catalog even
		// when the router is unreachable; live discovery replaces/augments
		// these on successful fetch. Context windows verified against
		// GET /v1/models: Claude models are 256k, GLM 5.3 is 1M.
		models: [
			{
				id: "claude-opus-5-5",
				name: "Claude Opus 5.5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 256000,
				maxTokens: 16000,
			},
			{
				id: "claude-sonnet-5",
				name: "Claude Sonnet 5",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 256000,
				maxTokens: 16000,
			},
			{
				id: "claude-fable-5.1",
				name: "Claude Fable 5.1",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 256000,
				maxTokens: 16000,
			},
			{
				id: "z-ai/glm-5.3",
				name: "GLM 5.3",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000000,
				maxTokens: 16000,
			},
		],
		async fetchDynamicModels(apiKey) {
			const entries = await fetchGhostModels(apiKey);
			const seen = new Set<string>();
			const models: GhostModelConfig[] = [];
			for (const entry of entries) {
				const config = toModelConfig(entry);
				if (!config || seen.has(config.id)) continue;
				seen.add(config.id);
				models.push(config);
			}
			return models;
		},
	});
}
