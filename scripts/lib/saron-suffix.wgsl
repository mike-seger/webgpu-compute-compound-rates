@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.totalOutputs) { return; }

  let n = params.numDays;

  if (params.mode == 0u) {
    output[0] = compoundRate(0u, n);
  } else if (params.mode == 1u) {
    output[idx] = compoundRate(idx, idx + 1u);
  } else {
    let nf = f32(n);
    let a = 2.0 * nf + 1.0;
    let disc = a * a - 8.0 * f32(idx);
    var offset = u32(floor((a - sqrt(max(disc, 0.0))) / 2.0));
    if (offset >= n) { offset = n - 1u; }
    var cum = offset * n - offset * (offset - 1u) / 2u;
    if (cum > idx && offset > 0u) {
      offset -= 1u;
      cum = offset * n - offset * (offset - 1u) / 2u;
    }
    let next_cum = cum + n - offset;
    if (idx >= next_cum && offset < n - 1u) {
      offset += 1u;
      cum = next_cum;
    }
    let edOffset = idx - cum;
    output[idx] = compoundRate(offset, offset + edOffset + 1u);
  }
}
