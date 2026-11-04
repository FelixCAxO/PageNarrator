// Freestanding C++: no libc, allocator, threads, or inference/model changes.
using u8 = unsigned char;
using i16 = short;
using u32 = unsigned int;
static_assert(sizeof(float) == 4 && sizeof(double) == 8 && sizeof(u32) == 4);

extern "C" void pcm_process(const float* input, u32 count, i16* output,
                             double floor, double ratio, int* bounds) {
  double peak = 0;
  for (u32 i = 0; i < count; ++i) {
    const double value = input[i], amplitude = __builtin_fabs(value);
    if (__builtin_isfinite(amplitude) && amplitude > peak) peak = amplitude;
    if (output) {
      const double sample = value != value ? 0 : value < -1 ? -1 : value > 1 ? 1 : value;
      output[i] = static_cast<i16>(sample * (sample < 0 ? 32768 : 32767));
    }
  }
  bounds[0] = bounds[1] = -1;
  if (peak <= 0) return;
  const double threshold = peak * ratio > floor ? peak * ratio : floor;
  for (u32 i = 0; i < count; ++i) {
    const double amplitude = __builtin_fabs(static_cast<double>(input[i]));
    if (!__builtin_isfinite(amplitude) || amplitude <= threshold) continue;
    if (bounds[0] < 0) bounds[0] = static_cast<int>(i);
    bounds[1] = static_cast<int>(i);
  }
}

// Preserve JavaScript double arithmetic before the final Float32 store.
static float pixel_tables[3][3][256];
static bool tables_ready = false;
extern "C" void rgba_pack(const u8* pixels, u32 width, u32 height,
                          u32 output_width, u32 mode, float* output) {
  if (!tables_ready) {
    const double mean[] = {.485, .456, .406}, deviation[] = {.229, .224, .225};
    for (u32 c = 0; c < 3; ++c) for (u32 p = 0; p < 256; ++p) {
      pixel_tables[0][c][p] = static_cast<float>(static_cast<double>(p) / 255);
      pixel_tables[1][c][p] = static_cast<float>((static_cast<double>(p) / 255 - mean[c]) / deviation[c]);
      pixel_tables[2][c][p] = static_cast<float>(static_cast<double>(p) / 127.5 - 1);
    }
    tables_ready = true;
  }
  for (u32 c = 0; c < 3; ++c) for (u32 y = 0; y < height; ++y) {
    float* row = output + (c * height + y) * output_width;
    const u8* source = pixels + y * width * 4 + 2 - c;
    for (u32 x = 0; x < width; ++x) row[x] = pixel_tables[mode][c][source[x * 4]];
    for (u32 x = width; x < output_width; ++x) row[x] = 0;
  }
}

extern "C" int detector_components(float* probabilities, u32 width, u32 height,
                                   double image_width, double image_height,
                                   u8* seen, u32* queue, double* boxes, u32 capacity) {
  const u32 size = width * height;
  for (u32 i = 0; i < size; ++i) {
    const double v = probabilities[i];
    if (!__builtin_isfinite(v) || v < -0x1p-23 || v > 1 + 0x1p-23) return -1;
    probabilities[i] = v <= 0 ? 0 : v > 1 ? 1 : v;
    seen[i] = 0;
  }
  int box_count = 0;
  for (u32 p = 0; p < size; ++p) {
    if (seen[p] || static_cast<double>(probabilities[p]) < .2) continue;
    u32 head = 0, tail = 1, count = 0, x0 = width, y0 = height, x1 = 0, y1 = 0;
    double sum = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    queue[0] = p; seen[p] = 1;
    while (head < tail) {
      const u32 q = queue[head++], x = q % width, y = q / width;
      ++count; sx += x; sy += y; sxx += static_cast<double>(x) * x;
      sxy += static_cast<double>(x) * y; sum += probabilities[q];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      // Same left/right/up/down traversal as the JavaScript implementation.
      const u32 next[] = {q - 1, q + 1, q - width, q + width};
      const bool valid[] = {x > 0, x + 1 < width, y > 0, y + 1 < height};
      for (u32 d = 0; d < 4; ++d) if (valid[d] && !seen[next[d]]
          && static_cast<double>(probabilities[next[d]]) >= .2) {
        seen[next[d]] = 1; queue[tail++] = next[d];
      }
    }
    if (count < 3 || sum / count < .4) continue;
    if (static_cast<u32>(box_count) >= capacity) return -2;
    const double variance = sxx - sx * sx / count;
    const double slope = variance > 0 ? (sxy - sx * sy / count) / variance : 0;
    double low = __builtin_inf(), high = -__builtin_inf();
    for (u32 j = 0; j < tail; ++j) {
      const u32 px = queue[j] % width, py = queue[j] / width;
      const double v = static_cast<double>(py) - slope * (static_cast<double>(px) - x0);
      if (v < low) low = v; if (v > high) high = v;
    }
    double* box = boxes + box_count++ * 8;
    box[0] = x0 * image_width / width; box[1] = low * image_height / height;
    box[2] = (x1 + 1) * image_width / width; box[3] = (high + 1) * image_height / height;
    box[4] = slope * (image_height / height) / (image_width / width);
    box[5] = sum / count; box[6] = count; box[7] = 0;
  }
  return box_count;
}
