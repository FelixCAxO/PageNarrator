"""Independent CPU phase-boundary experiment; does not import upstream Kokoro code."""
import json
import argparse
from pathlib import Path
import torch

torch.set_num_threads(1)
real = torch.tensor([-1., -1., 1., 1., 0., 0., -0., -0.], dtype=torch.float32, device='cpu')
imag = torch.tensor([0., -0., 0., -0., 0., -0., 0., -0.], dtype=torch.float32, device='cpu')
value = torch.complex(real, imag)
ratio = torch.atan(imag / real)
exported = torch.where(real < 0, torch.where(imag > 0, ratio + torch.pi, ratio - torch.pi), ratio)
canonical = torch.where((imag == 0) & (real < 0), torch.full_like(real, torch.pi), exported)
canonical = torch.where((imag == 0) & (real == 0), torch.zeros_like(real), canonical)
signal = -torch.ones(1, 40, dtype=torch.float32, device='cpu')
spectrum = torch.stft(signal, 20, 5, 20, window=torch.hann_window(20, device='cpu'), return_complex=True, center=False)
assert torch.angle(value)[0] > 0 and exported[0] < 0
assert torch.angle(value)[1] < 0 and canonical[1] > 0  # Model convention explicitly canonicalizes both zero signs.
assert torch.isnan(exported[4:]).all() and torch.equal(canonical[4:], torch.zeros(4))
assert not torch.signbit(canonical[4:]).any()  # Canonical origin, not IEEE negative-zero quadrants.
assert torch.equal(torch.signbit(torch.angle(value)[4:]), torch.tensor([False, True, False, True]))
assert torch.equal(spectrum[0, 0].imag, torch.zeros(5)) and not torch.signbit(spectrum[0, 0].imag).any()
assert (torch.angle(spectrum[0, 0]) > 0).all()
report = {
    'status': 'pass', 'scope': 'CPU independent mathematical boundary experiment, not full trained-model or listening acceptance',
    'torchVersion': torch.__version__, 'device': 'cpu',
    'primarySources': [
        'https://github.com/hexgrad/kokoro/blob/93abff8795bfb00f78a14fa5d551198f445067ab/kokoro/custom_stft.py#L135-L139',
        'https://github.com/hexgrad/kokoro/blob/dfb907a02bba8152ca444717ca5d78747ccb4bec/kokoro/istftnet.py#L80-L94',
        'https://docs.pytorch.org/docs/stable/generated/torch.angle.html'],
    'signedZero': {'real': real.tolist(), 'imaginary': imag.tolist(), 'imaginarySignbits': torch.signbit(imag).tolist(),
                   'torchAngle': torch.angle(value).tolist(), 'exportedBranch': exported.tolist(), 'canonicalModelCorrection': canonical.tolist()},
    'negativeConstantStft': {'signal': '40 samples of -1, periodic Hann20, hop5, center=False',
                             'dcReal': spectrum[0, 0].real.tolist(), 'dcImaginary': spectrum[0, 0].imag.tolist(),
                             'dcPhase': torch.angle(spectrum[0, 0]).tolist()},
    'boundary': 'Official canonical +pi for imaginary zero/negative real; explicit +0 at coincident zero for either zero sign. The captured +0/+0 matches Torch, while negative-zero origin quadrants are an explicitly narrower canonical convention. No epsilon, changed nonzero phase, or oracle tensor injection.'}
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='artifacts/engines/kokoro-phase-contract-v2.json')
output = Path(parser.parse_args().output).resolve()
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': report['status'], 'output': str(output)}))
