"""Capture an explicitly selected, non-default Windows output loopback; never a microphone."""
import argparse
import json
import time
import wave
from pathlib import Path
import pyaudiowpatch as pa

p = argparse.ArgumentParser()
p.add_argument("output")
p.add_argument("--seconds", type=float, default=90)
p.add_argument("--stop-file", type=Path)
p.add_argument("--device-index", type=int, required=True)
a = p.parse_args()
with pa.PyAudio() as audio:
    device = audio.get_device_info_by_index(a.device_index)
    if not device.get("isLoopbackDevice"):
        raise RuntimeError("Refusing non-loopback input")
    if device["index"] == audio.get_default_wasapi_loopback()["index"]:
        raise RuntimeError("Default output capture is disabled; select an isolated non-default output route")
    rate, channels = int(device["defaultSampleRate"]), device["maxInputChannels"]
    with wave.open(a.output, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        def record(data, _frames, _time_info, status):
            if status:
                metadata.setdefault("captureWarnings", []).append(status)
            wav.writeframes(data)
            return (None, pa.paContinue)

        with audio.open(format=pa.paInt16, channels=channels, rate=rate,
                        input=True, input_device_index=device["index"],
                        frames_per_buffer=1024, stream_callback=record,
                        start=False) as stream:
            started = time.time()
            metadata = {"startedEpochSeconds": started, "device": device,
                        "rate": rate, "channels": channels, "bufferFrames": 1024,
                        "scope": "explicitly selected non-default output mix; other audio may contaminate"}
            Path(a.output + ".json").write_text(json.dumps(metadata, indent=2))
            print(json.dumps(metadata), flush=True)
            stream.start_stream()
            while time.time() - started < a.seconds:
                if a.stop_file and a.stop_file.exists():
                    break
                time.sleep(0.05)
            stream.stop_stream()
            metadata["stoppedEpochSeconds"] = time.time()
            Path(a.output + ".json").write_text(json.dumps(metadata, indent=2))
