// Compensated accumulation: tracks p = (product - 1) directly,
// avoiding catastrophic cancellation when product ≈ 1.
// p_new = p * (1 + delta) + delta  =  p + delta + p * delta
fn compoundRate(start: u32, end: u32) -> df64 {
  var i = start;
  var p: f32 = 0.0;
  while (i < end) {
    var weight = weights[i];
    if (weight > 1u && i + weight >= end) {
      weight = end - i;
    }
    let delta = rates[i].x * f32(weight) / 36000.0;
    p = p + delta + p * delta;
    i += weight;
  }
  let result = p * 36000.0 / f32(end - start);
  return df64(result, 0.0);
}
