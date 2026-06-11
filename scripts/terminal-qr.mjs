const lowEcVersions = [
  null,
  { size: 21, dataCodewords: 19, eccCodewords: 7, align: [] },
  { size: 25, dataCodewords: 34, eccCodewords: 10, align: [6, 18] },
  { size: 29, dataCodewords: 55, eccCodewords: 15, align: [6, 22] },
  { size: 33, dataCodewords: 80, eccCodewords: 20, align: [6, 26] },
  { size: 37, dataCodewords: 108, eccCodewords: 26, align: [6, 30] }
];

const gfExp = new Array(512);
const gfLog = new Array(256);
let gfValue = 1;
for (let index = 0; index < 255; index += 1) {
  gfExp[index] = gfValue;
  gfLog[gfValue] = index;
  gfValue <<= 1;
  if (gfValue & 0x100) gfValue ^= 0x11d;
}
for (let index = 255; index < gfExp.length; index += 1) {
  gfExp[index] = gfExp[index - 255];
}

export function renderQr(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = chooseVersion(bytes.length);
  const modules = encodeQr(bytes, version);
  return renderTerminal(modules);
}

function chooseVersion(byteLength) {
  for (let version = 1; version < lowEcVersions.length; version += 1) {
    const config = lowEcVersions[version];
    const requiredBits = 4 + 8 + byteLength * 8;
    if (requiredBits <= config.dataCodewords * 8) {
      return version;
    }
  }
  throw new Error("URL is too long for the built-in QR renderer");
}

function encodeQr(bytes, version) {
  const config = lowEcVersions[version];
  const dataCodewords = encodeData(bytes, config.dataCodewords);
  const eccCodewords = reedSolomon(dataCodewords, config.eccCodewords);
  const codewords = [...dataCodewords, ...eccCodewords];
  const base = createBaseMatrix(config);

  drawCodewords(base, codewords);

  let bestModules = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = applyMask(base, mask);
    drawFormatBits(candidate.modules, candidate.reserved, candidate.size, mask);
    const score = penaltyScore(candidate.modules);
    if (score < bestScore) {
      bestScore = score;
      bestModules = candidate.modules;
    }
  }

  return bestModules;
}

function encodeData(bytes, dataCodewordCount) {
  const capacityBits = dataCodewordCount * 8;
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const terminatorLength = Math.min(4, capacityBits - bits.length);
  appendBits(bits, 0, terminatorLength);
  while (bits.length % 8 !== 0) bits.push(false);

  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) {
      value = (value << 1) | (bits[index + offset] ? 1 : 0);
    }
    codewords.push(value);
  }

  for (let padIndex = 0; codewords.length < dataCodewordCount; padIndex += 1) {
    codewords.push(padIndex % 2 === 0 ? 0xec : 0x11);
  }

  return codewords;
}

function appendBits(bits, value, length) {
  for (let index = length - 1; index >= 0; index -= 1) {
    bits.push(((value >>> index) & 1) !== 0);
  }
}

function createBaseMatrix(config) {
  const modules = createMatrix(config.size, null);
  const reserved = createMatrix(config.size, false);
  const base = { modules, reserved, size: config.size };

  drawFinder(base, 0, 0);
  drawFinder(base, config.size - 7, 0);
  drawFinder(base, 0, config.size - 7);
  drawAlignmentPatterns(base, config.align);
  drawTimingPatterns(base);
  reserveFormatAreas(base);
  setFunction(base, 8, config.size - 8, true);

  return base;
}

function createMatrix(size, value) {
  return Array.from({ length: size }, () => Array(size).fill(value));
}

function setFunction(base, x, y, dark) {
  if (x < 0 || y < 0 || x >= base.size || y >= base.size) return;
  base.modules[y][x] = dark;
  base.reserved[y][x] = true;
}

function drawFinder(base, x, y) {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const inPattern = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
      const dark = inPattern && (
        dx === 0 || dx === 6 || dy === 0 || dy === 6
        || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)
      );
      setFunction(base, x + dx, y + dy, dark);
    }
  }
}

function drawAlignmentPatterns(base, positions) {
  for (const x of positions) {
    for (const y of positions) {
      const nearTopLeft = x === 6 && y === 6;
      const nearTopRight = x === base.size - 7 && y === 6;
      const nearBottomLeft = x === 6 && y === base.size - 7;
      if (nearTopLeft || nearTopRight || nearBottomLeft) continue;
      drawAlignment(base, x, y);
    }
  }
}

function drawAlignment(base, centerX, centerY) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(base, centerX + dx, centerY + dy, distance !== 1);
    }
  }
}

function drawTimingPatterns(base) {
  for (let index = 8; index < base.size - 8; index += 1) {
    const dark = index % 2 === 0;
    setFunction(base, 6, index, dark);
    setFunction(base, index, 6, dark);
  }
}

function reserveFormatAreas(base) {
  for (let index = 0; index <= 8; index += 1) {
    if (index !== 6) {
      setFunction(base, 8, index, false);
      setFunction(base, index, 8, false);
    }
  }

  for (let index = 0; index < 8; index += 1) {
    setFunction(base, base.size - 1 - index, 8, false);
  }
  for (let index = 0; index < 7; index += 1) {
    setFunction(base, 8, base.size - 1 - index, false);
  }
}

function drawCodewords(base, codewords) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  let bitIndex = 0;
  let upward = true;
  for (let right = base.size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let row = 0; row < base.size; row += 1) {
      const y = upward ? base.size - 1 - row : row;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (base.reserved[y][x]) continue;
        base.modules[y][x] = bitIndex < bits.length ? bits[bitIndex] : false;
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(base, mask) {
  const modules = base.modules.map((row) => row.slice());
  const reserved = base.reserved.map((row) => row.slice());
  for (let y = 0; y < base.size; y += 1) {
    for (let x = 0; x < base.size; x += 1) {
      if (!reserved[y][x] && maskApplies(mask, x, y)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
  return { modules, reserved, size: base.size };
}

function maskApplies(mask, x, y) {
  if (mask === 0) return (x + y) % 2 === 0;
  if (mask === 1) return y % 2 === 0;
  if (mask === 2) return x % 3 === 0;
  if (mask === 3) return (x + y) % 3 === 0;
  if (mask === 4) return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
  if (mask === 5) return ((x * y) % 2) + ((x * y) % 3) === 0;
  if (mask === 6) return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
  return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
}

function drawFormatBits(modules, reserved, size, mask) {
  const bits = formatBits(mask);
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  for (let index = 0; index <= 5; index += 1) set(8, index, getBit(bits, index));
  set(8, 7, getBit(bits, 6));
  set(8, 8, getBit(bits, 7));
  set(7, 8, getBit(bits, 8));
  for (let index = 9; index < 15; index += 1) set(14 - index, 8, getBit(bits, index));

  for (let index = 0; index < 8; index += 1) set(size - 1 - index, 8, getBit(bits, index));
  for (let index = 8; index < 15; index += 1) set(8, size - 15 + index, getBit(bits, index));
  set(8, size - 8, true);
}

function formatBits(mask) {
  const errorCorrectionLevel = 1;
  const data = (errorCorrectionLevel << 3) | mask;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >>> bit) & 1) !== 0) {
      remainder ^= 0x537 << (bit - 10);
    }
  }
  return ((data << 10) | remainder) ^ 0x5412;
}

function getBit(value, index) {
  return ((value >>> index) & 1) !== 0;
}

function reedSolomon(data, eccLength) {
  const generator = rsGenerator(eccLength);
  const remainder = Array(eccLength).fill(0);
  for (const value of data) {
    const factor = value ^ remainder.shift();
    remainder.push(0);
    if (factor === 0) continue;
    for (let index = 0; index < remainder.length; index += 1) {
      remainder[index] ^= gfMultiply(generator[index], factor);
    }
  }
  return remainder;
}

function rsGenerator(degree) {
  let polynomial = [1];
  for (let index = 0; index < degree; index += 1) {
    polynomial = multiplyPolynomial(polynomial, [1, gfExp[index]]);
  }
  return polynomial.slice(1);
}

function multiplyPolynomial(left, right) {
  const result = Array(left.length + right.length - 1).fill(0);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      result[leftIndex + rightIndex] ^= gfMultiply(left[leftIndex], right[rightIndex]);
    }
  }
  return result;
}

function gfMultiply(left, right) {
  if (left === 0 || right === 0) return 0;
  return gfExp[gfLog[left] + gfLog[right]];
}

function penaltyScore(modules) {
  let score = 0;
  const size = modules.length;

  for (let y = 0; y < size; y += 1) score += runPenalty(modules[y]);
  for (let x = 0; x < size; x += 1) {
    score += runPenalty(modules.map((row) => row[x]));
  }

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const color = modules[y][x];
      if (
        color === modules[y][x + 1]
        && color === modules[y + 1][x]
        && color === modules[y + 1][x + 1]
      ) {
        score += 3;
      }
    }
  }

  for (let y = 0; y < size; y += 1) score += finderPenalty(modules[y]);
  for (let x = 0; x < size; x += 1) {
    score += finderPenalty(modules.map((row) => row[x]));
  }

  const darkCount = modules.flat().filter(Boolean).length;
  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;

  return score;
}

function runPenalty(line) {
  let score = 0;
  let current = line[0];
  let length = 1;
  for (let index = 1; index < line.length; index += 1) {
    if (line[index] === current) {
      length += 1;
      continue;
    }
    if (length >= 5) score += length - 2;
    current = line[index];
    length = 1;
  }
  if (length >= 5) score += length - 2;
  return score;
}

function finderPenalty(line) {
  const patterns = [
    [true, false, true, true, true, false, true, false, false, false, false],
    [false, false, false, false, true, false, true, true, true, false, true]
  ];

  let score = 0;
  for (let index = 0; index <= line.length - 11; index += 1) {
    for (const pattern of patterns) {
      if (pattern.every((value, offset) => line[index + offset] === value)) {
        score += 40;
      }
    }
  }
  return score;
}

function renderTerminal(modules) {
  const quietZone = 4;
  const light = "\x1b[47m  ";
  const dark = "\x1b[40m  ";
  const reset = "\x1b[0m";
  const rows = [];

  for (let y = -quietZone; y < modules.length + quietZone; y += 1) {
    let row = "";
    for (let x = -quietZone; x < modules.length + quietZone; x += 1) {
      const module = modules[y]?.[x] || false;
      row += module ? dark : light;
    }
    rows.push(`${row}${reset}`);
  }

  return rows.join("\n");
}
