@group(0) @binding(0) var<storage, read> rates: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> weights: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<vec2<f32>>;

struct Params {
  numDays: u32,
  mode: u32,
  totalOutputs: u32,
  _pad: u32,
}
@group(0) @binding(3) var<uniform> params: Params;

// --- df64: double-f32 emulation (~48-bit mantissa precision) ---

alias df64 = vec2<f32>; // .x = hi, .y = lo;  value = hi + lo

fn quickTwoSum(a: f32, b: f32) -> df64 {
  let s = a + b;
  let e = b - (s - a);
  return df64(s, e);
}

fn twoSum(a: f32, b: f32) -> df64 {
  let s = a + b;
  let v = s - a;
  let e = (a - (s - v)) + (b - v);
  return df64(s, e);
}

fn twoProd(a: f32, b: f32) -> df64 {
  let p = a * b;
  let e = fma(a, b, -p);  // hardware FMA gives exact error
  return df64(p, e);
}

fn df64_from(a: f32) -> df64     { return df64(a, 0.0); }

fn df64_add(a: df64, b: df64) -> df64 {
  var s = twoSum(a.x, b.x);
  let t = twoSum(a.y, b.y);
  s = quickTwoSum(s.x, s.y + t.x);
  s = quickTwoSum(s.x, s.y + t.y);
  return s;
}

fn df64_add_f32(a: df64, b: f32) -> df64 {
  var s = twoSum(a.x, b);
  s = quickTwoSum(s.x, s.y + a.y);
  return s;
}

fn df64_mul(a: df64, b: df64) -> df64 {
  let p = twoProd(a.x, b.x);
  let e = a.x * b.y + a.y * b.x + p.y;
  return quickTwoSum(p.x, e);
}

fn df64_mul_f32(a: df64, b: f32) -> df64 {
  let p = twoProd(a.x, b);
  let e = a.y * b + p.y;
  return quickTwoSum(p.x, e);
}

fn df64_div(a: df64, b: df64) -> df64 {
  let q1 = a.x / b.x;
  let r = df64_add(a, df64_mul_f32(b, -q1));
  let q2 = r.x / b.x;
  return quickTwoSum(q1, q2);
}
