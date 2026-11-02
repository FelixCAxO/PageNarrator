# Reject generic capacity rounding; isolate long-request device loss

This continues the accepted [repeat-workspace placement](workspace-placement-20261031.md). The application source remains byte-identical to that measured baseline. The first experiment rounds cold temporary allocations to 4 KiB. It saves some decoder capacity, but explicit cache-limit checks expose an extra capture and some decoder shapes retain substantially more GPU memory afterward. Generic rounding is rejected.

A second, artifact-only experiment divides captured work into separate GPU queue submissions. It allows the previously failing long Intel request to complete in diagnostic runs. This is a portability candidate, not an accepted production optimization or CPU-saving claim.

## Test the real decoder across shapes

The probe uses the frozen 115,922,662-byte decoder, SHA-256 `12ddfca66e030e9ece90106d117a9b61ea25e64e510ca4c677e65d6ecabb9cc2`, with deterministic in-range codes. It runs 26 frame lengths on NVIDIA and Intel: 16, 32, 76, 77, 100, 128, 144, 152, 156–166, 168, 176, 192, 237, 300, 475 and 600. GPU and CPU execution plans are cleared before each cold shape; model weights and compiled pipelines remain shared within the variant. Every shape also has a following identical request.

The candidate changes only fresh, unplaced output storage while bounded lifetime recording is active. Capacities of at least 4,096 bytes round upward to a 4 KiB multiple, provided the result fits both device buffer limits. Inputs, weights, flags, parameters, learned placement, arithmetic and shaders retain their existing rules. The probe compares raw float32 output within each architecture and checks GPU cleanup and validation.

All **104 decoder output pairs** match exactly, including cold and following requests on both GPUs. The 475-frame case produces 456,000 samples, or 19 seconds at 24 kHz. Its first request allocates **383,299,584 bytes in 14 buffers**, versus **402,753,376 bytes in 15 buffers**. This is a 19,453,792-byte, or 18.55 MiB, reduction in engine-owned capacity. It is not a measurement of complete resident VRAM.

This decoder-only result also narrows the earlier Intel failure: its large decoder can execute independently at up to 600 frames, or 24 seconds of output. The prior full-model failure occurred before decoder entry.

## A cache threshold can reverse the benefit

Two actual GPU Relu models check cache admission: 1,025 float32 elements with an 8,400-byte budget, and 16,777,200 elements with the normal 128 MiB budget. Each runs three times per variant and architecture. All **12 boundary output pairs** match exactly.

| Boundary | Exact-capacity plan | Rounded plan | Baseline cache-hit sequence | Rounded sequence |
| --- | ---: | ---: | --- | --- |
| 8,400-byte budget | 8,328 B | 12,420 B | false, true, true | false, false, true |
| 128 MiB budget | 134,217,728 B | 134,217,792 B | false, true, true | false, false, true |

The default-budget example misses admission by just **64 bytes**. The following request must capture again using its learned exact-size hint before the GPU plan fits. Increasing the cache limit would change the memory contract rather than solve the allocation policy.

Decoder frames 159–166 also enter the GPU cache earlier after rounding. The baseline instead learns its compact placement and retains the compact plan on the following request. Earlier admission preserves the rounded plan's fragmentation: the candidate retains up to **72,759,296 extra bytes, or 69.39 MiB**, after that following request. Thus an earlier cache hit is not sufficient evidence of a memory improvement.

The offline simulator reproduces all 26 real rounded allocation counts and byte totals on both architectures. A guarded variant rounds only after exact allocations already exceed the 128 MiB budget, preserving admission for formerly cacheable plans. It projects no allocation reduction on any tested shape. That guarded variant is not implemented or GPU-qualified. The generic rounding proposal remains outside application source.

## Bound long main-model submissions

The two-step long-request diagnostic uses the same 475-frame request, weights and shaders, with two diffusion steps solely to isolate the failure. The original Intel path fails with `DXGI_ERROR_DEVICE_HUNG (0x887A0006)` before a decoder run. Splitting a single encoder into 32-command compute passes still fails. Splitting into multiple command buffers but submitting them together also fails.

Submitting each bounded command buffer separately succeeds at chunk sizes 32, 128 and 256. Completion-marker callbacks are unnecessary: the 32-command variant also succeeds with those callbacks disabled. The experiments preserve dispatch order and buffer bindings; they re-encode already captured groups and copies. They do not change any tensor calculation or the production step setting.

On NVIDIA, the ordinary and 32-command pass-only diagnostics have identical half-logit hashes, codes, raw PCM and WAVs. Intel and NVIDIA outputs are compared within each architecture; this experiment does not establish cross-architecture bit equality. Timings include diagnostic hashing and are excluded from performance acceptance.

Full **24-step** controls compare all 48 generated-row half-logit tensors, codes, raw PCM and WAVs within each GPU. NVIDIA's unmodified path and the 128-command prototype match exactly. Intel's working 32-command and 128-command prototypes also match exactly. The failing unmodified Intel path is not used as a numerical baseline. Two-step Intel diagnostics at queue sizes 32, 128 and 256 also match exactly.

| Full 24-step diagnostic | Baseline configuration | Baseline | 128-command prototype |
| --- | --- | ---: | ---: |
| NVIDIA | Unmodified submissions | 5,155.1 ms | 5,204.4 ms |
| Intel | Working 32-command prototype | 92,974.2 ms | 92,598.7 ms |

These are single instrumented observations, not counterbalanced performance acceptance. The 128-command full trial issues 530 captured-work submissions. Its CPU and scheduling overhead still need measurement. Intel produces 19 seconds of speech in about 93 seconds; this remains far from real-time on that integrated GPU.

The native probe normally creates separate main and decoder engines. An additional control uses one shared float16-capable engine, two main plans and one decoder plan, matching the application's core arrangement. Unmodified shared execution still loses its device on the two-step long request. The 128-command shared prototype completes both that request and a full 24-step request. All 48 full-request half-logit tensors, codes and returned PCM/WAVs match the separate-engine 128-command control exactly; shared-engine synthesis takes 92,558.4 ms. GPU buffers and tensors return to zero at cleanup. This verifies the shared source runtime, not the packaged worker or physical 8 GiB hardware.

## Evidence and remaining work

Ignored `artifacts/cold-workspace-20261031/` contains the saved current source, rounding prototype, both architecture reports, exact cache-boundary cases, interval simulations and submission diagnostics. `analyze-shapes.mjs` asserts the expected numerical values, cache-hit sequences, allocation simulation and cleanup before deriving `shape-summary.json`. `verification.json` binds those results, failed controls, full-step comparisons, shared-engine control and current application source/reachable bundle to the previously verified baseline. Timed and synthesis work runs serially under the host measurement lock.

The application keeps the previously verified 1,569-test baseline. Rounding is rejected. Bounded queue submissions need production implementation, error/recovery tests, paired whole-browser CPU/memory/timing, exact speech/logit controls and continued playback verification before acceptance. The application's packaged shared-engine worker still needs its own check. Production implementation should form bounded command buffers while encoding, avoiding the diagnostic prototype's first-capture re-encoding.

The host is a Core Ultra 9 285K with about 63.3 GiB RAM and an RTX 5090 with nominal 32 GiB VRAM; Intel Xe-LPG supplies additional controls. Physical 8 GiB RAM/VRAM systems, weaker dedicated GPUs, device audio, energy and broad PDF/OCR remain unqualified. The broader goal remains active.
