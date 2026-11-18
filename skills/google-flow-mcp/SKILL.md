---
name: google-flow-mcp
description: Orchestrate AI video and image production on Google Flow (flow.google.com) via the remote Streamable HTTP MCP server (Veo 3.1 Quality/Fast/Lite, Omni Flash, Nano Banana Pro/2, Imagen 4, and ffmpeg scene export). Use whenever the user asks to generate videos, clips, start-frames, storyboards, b-roll, or multi-shot scenes using Google Flow, Veo 3.1, Omni Flash, or Nano Banana, or to check Google Flow MCP status, credits, and jobs.
---

# Google Flow MCP

Drive the remote Google Flow MCP server (`google-flow-mcp-http`) safely and cost-efficiently across image generation, Veo 3.1 / Omni Flash video rendering, timeout recovery, and multi-shot MP4 scene assembly.

## When to Use

- Generate AI video clips with Veo 3.1 (`Veo 3.1 Lite`, `Veo 3.1 Fast`, `Veo 3.1 Quality`) or `Omni Flash` through Google Flow subscription credits.
- Create keyframes, character references, or storyboard stills with `Nano Banana 2`, `Nano Banana Pro`, or `Imagen 4`.
- Concatenate multiple generated clips into one normalized 24 fps MP4 via `flow_export_scene`.
- Check Google Flow browser session health, credit balance, daily credit spend, or recover timed-out jobs.

## Steps

### 1. Pre-Flight Session and Credit Verification

Before starting a batch or video generation workflow, call `flow_status` once to confirm readiness:

- Verify `cdpReachable: true` and `signedIn: true`.
- If `cdpReachable` is `false` or a tab renderer crashed, call `flow_doctor` with `closeHungTabs: true` once. If `signedIn` remains `false`, stop and instruct the user to re-authenticate in the local Chrome or KasmVNC session rather than retrying generation calls.
- Inspect `queue.todaySpentCredits`, `queue.dailyCreditCap`, and `detectedCreditsBalance` so your planned shots stay within budget.

### 2. Model Tiering and Cost Guardrails

Select the lightest model that matches the stage of creative iteration so subscription credits are not burned on unverified prompts:

- **Drafting and Keyframes (`flow_generate_image`)**: Default to `Nano Banana 2` (~1 credit) for layout and composition tests. Upgrade to `Nano Banana Pro` or `Imagen 4` (~2 credits) for final hero frames or video reference ingredients.
- **Motion Blocking and Previews (`flow_generate_video`)**: Default to `Omni Flash` (~5 credits) or `Veo 3.1 Lite` (~10 credits) when validating camera motion or pacing.
- **Production Clips (`flow_generate_video`)**: Use `Veo 3.1 Fast` (~20 credits) for standard production shots. Reserve `Veo 3.1 Quality` (~100 credits) only when the user explicitly asks for maximum quality or approves a preview.
- **Dry-Run Quotes**: Set `dryRun: true` when testing unfamiliar settings or verifying exact UI credit quotes without clicking Generate. Always pass an explicit `maxCredits` cap (`25` for standard runs, `120` only for approved `Veo 3.1 Quality` shots).

### 3. Prompt Engineering for Flow Video Models

Structure every `flow_generate_video` prompt with five concrete components instead of vague keywords:

1. **Subject and Wardrobe**: Specific visual appearance so shots stay consistent across clips.
2. **Primary Action**: Clear, single-beat movement fitting a 4-8 second shot (avoid cramming three separate scenes into one clip).
3. **Environment and Lighting**: Time of day, light direction, atmosphere, and color palette.
4. **Camera and Lens**: Explicit framing and camera move (for example: `medium close-up, slow dolly in, 35mm lens, shallow depth of field, handheld subtle motion`).
5. **Audio and Ambience**: Concrete sound cues (dialogue tone, foley, ambient room tone, or music mood), because Veo 3.1 generates synchronized native audio.

### 4. Timeout-Safe Execution and Zero-Duplicate Recovery

Video rendering on Google Flow takes 60 to 240 seconds. If a network proxy, reverse proxy, or Cloudflare Tunnel drops the HTTP connection (such as HTTP 524) before `flow_generate_video` returns:

1. **Do NOT re-send a fresh `flow_generate_video` call** with the same prompt right away, because the job is likely still rendering inside Chrome and a second call will spend credits twice.
2. Call `flow_list_history` (`limit: 5`) to locate the active or most recent `jobId` matching your prompt.
3. Call `flow_job_status` with that `jobId`. If its status is still `running` or timed out waiting for tiles, call `flow_generate_video` passing `resumeJobId: "<jobId>"` to poll and download the finished MP4 at zero additional credit cost.

### 5. Consuming Signed Media URLs and Assembling Scenes

- Each completed job returns `outputs[]` containing `filename`, `bytes`, `expiresAt`, and `downloadUrl` (an HMAC-SHA256 signed HTTPS URL at `/media/<filename>?exp=...&sig=...`).
- Share `downloadUrl` directly or fetch it immediately in downstream pipelines (`curl -fL`, `ffmpeg`, or video editors) before `expiresAt` passes.
- For multi-shot sequences (reels, explainers, storyboards), generate each clip sequentially, collect each `outputs[0].filename`, and call `flow_export_scene` with `clipFilenames` in timeline order to produce a single normalized 24 fps H.264/AAC MP4 (`+faststart`) with its own signed `downloadUrl`.

## Gotchas

- **Serialize multi-shot calls**: The server enforces a global single-job mutex over one physical Chrome tab so Google Flow UI interactions never collide. Issue multi-shot `flow_generate_video` calls sequentially (or verify `queue.pendingCount`) rather than firing large parallel bursts that risk client-side request timeouts while waiting in queue.
- **Reference paths live on the MCP host**: `referenceImagePaths` expects file paths accessible on the MCP server filesystem (such as `./exports/<filename>` from an earlier `flow_generate_image` call in the same server), not paths from a separate client container. Chain `flow_generate_image` `localPath` directly into `flow_generate_video` `referenceImagePaths` for image-to-video continuity.
- **Self-healing UI changes**: Google Flow uses Material icon ligatures without static test IDs. If generation fails with a missing button or selector error after a Google Flow UI update, call `flow_discover_ui` once to inspect live interactive elements and report the exact updated selector for `config/selectors.map.json` instead of looping retries.
