"""Independent CPU FFT/angle experiment on identical captured real signal samples."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
import torch

args = argparse.ArgumentParser()
args.add_argument('--manifest', required=True)
opts = args.parse_args()
manifest_path = Path(opts.manifest)
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
torch.set_num_threads(1)
report = {'scope': manifest['scope'], 'torchVersion': torch.__version__, 'device': 'cpu', 'modelSha256': manifest['modelSha256'], 'cases': []}

def metrics(actual, expected):
    error = actual.astype(np.float64) - expected.astype(np.float64)
    return {'maximumAbsolute': float(np.max(np.abs(error))), 'relativeRmse': float(np.sqrt(np.sum(error ** 2) / max(1e-30, np.sum(expected.astype(np.float64) ** 2))))}

for entry in manifest['cases']:
    def load(name):
        pin = entry['files'][name]
        data = (manifest_path.parent / pin['filename']).read_bytes()
        assert len(data) == pin['bytes'] and hashlib.sha256(data).hexdigest() == pin['sha256']
        return np.frombuffer(data, dtype='<f4').copy()
    signal = load('signal').reshape(entry['signalShape'])
    if signal.ndim == 3:
        signal = signal[:, :, 0]
    window = load('window')
    transformed = torch.stft(torch.from_numpy(signal), 20, 5, 20, window=torch.from_numpy(window), center=False, return_complex=True)
    expected = torch.view_as_real(transformed).permute(0, 2, 1, 3).contiguous().numpy()
    own = load('own').reshape(entry['spectrumShape'])
    ort = load('ort').reshape(entry['spectrumShape'])
    phase = torch.angle(transformed).permute(0, 2, 1).contiguous().numpy()
    re, im = own[..., 0], own[..., 1]
    with np.errstate(divide='ignore', invalid='ignore'):
        atan = np.arctan(im / re)
        exported = np.where(re < 0, np.where(im > 0, atan + np.float32(np.pi), atan - np.float32(np.pi)), atan)
    corrected = np.where((im == 0) & (re < 0), np.float32(np.pi), exported)
    # The measured fixed contract is limited to mathematically real DC/Nyquist.
    # Other near-zero bins remain a reported numerical-sensitivity diagnostic.
    real_bins = np.array([0, 10])
    torch_real = expected[:, :, real_bins, :]
    original_real = own[:, :, real_bins, :]
    assert np.all(original_real[..., 1] == 0) and not np.any(np.signbit(original_real[..., 1]))
    assert np.all(torch_real[..., 1] == 0) and not np.any(np.signbit(torch_real[..., 1]))
    phase_error = np.abs(corrected[:, :, real_bins] - phase[:, :, real_bins])
    exact_real_bin_contract = bool(np.isfinite(phase_error).all() and np.max(phase_error) < 1e-6)
    own_angle = torch.angle(torch.view_as_complex(torch.from_numpy(own.copy()).contiguous())).numpy()
    own_phase_error = np.abs(corrected - own_angle)
    canonical_same_spectrum_pass = bool(np.isfinite(own_phase_error).all() and np.max(own_phase_error) < 1e-6)
    differences = []
    for batch, frame, selected_bin in np.argwhere(phase_error > 1e-6)[:12]:
        frequency = int(real_bins[selected_bin])
        differences.append({'batch': int(batch), 'frame': int(frame), 'bin': frequency,
                            'ownReal': float(own[batch, frame, frequency, 0]), 'torchReal': float(expected[batch, frame, frequency, 0]),
                            'correctedOwnPhase': float(corrected[batch, frame, frequency]), 'torchPhase': float(phase[batch, frame, frequency])})
    record = {'id': entry['id'], 'voice': entry['voice'], 'signalShape': entry['signalShape'], 'spectrumShape': entry['spectrumShape'],
              'spectrumOwnVsTorch': metrics(own, expected), 'spectrumOrtVsTorch': metrics(ort, expected),
              'rawPhaseOwnVsTorch': metrics(exported, phase), 'correctedPhaseOwnVsTorch': metrics(corrected, phase),
              'realBinElements': int(phase_error.size), 'realBinMaximumPhaseError': float(np.max(phase_error)),
              'realBinUncorrectedPhaseFlips': int(np.sum(np.abs(exported[:, :, real_bins] - phase[:, :, real_bins]) > 6)),
              'realBinPhaseDisagreementCount': int(np.sum(phase_error > 1e-6)), 'realBinPhaseDisagreements': differences,
              'correctedPhaseFlipsAllBins': int(np.sum(np.abs(corrected - phase) > 6)),
              'nonzeroSpectrumMinimumMagnitude': float(np.min(np.abs(transformed.numpy())[np.abs(transformed.numpy()) > 0])),
              'exactRealBinContractPass': exact_real_bin_contract, 'canonicalPhaseOnSameSpectrumVsTorchMaximum': float(np.max(own_phase_error)),
              'canonicalPhaseOnSameSpectrumVsTorchPass': canonical_same_spectrum_pass}
    report['cases'].append(record)
report['status'] = 'pass' if all(entry['exactRealBinContractPass'] for entry in report['cases']) and manifest['remainingBuffers'] == 0 and manifest['remainingTensors'] == 0 else 'fail'
report['canonicalPhaseOnSameSpectrumStatus'] = 'pass' if all(entry['canonicalPhaseOnSameSpectrumVsTorchPass'] for entry in report['cases']) else 'fail'
report['acceptanceBoundary'] = 'Exact all-real-bin FFT phase parity remains a strict unchanged gate. A separate same-spectrum phase check tests the documented +pi contract without requiring two different FFT summation orders to have identical signs at near-zero real values. No epsilon or oracle spectral tensor is used in production; full-model PCM and broad quality remain separate gates.'
output = manifest_path.parent / 'torch-report.json'
output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report))
raise SystemExit(0 if report['status'] == 'pass' else 1)
