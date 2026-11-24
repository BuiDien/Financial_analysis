// OCR Inbox: exact decimal arithmetic on digit strings (no floats), for level-total checks (pure; node-testable).

const parseExactDecimal = input => {
  let value = String(input || '').replace(/(\*\*|__|`)/g, '').trim();
  if (!value || /%/.test(value) || /[A-Za-z]/.test(value)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  value = value.replace(/[−–—]/g, '-').replace(/\s/g, '').replace(/[^\d.,+-]/g, '');
  if (!/^[+-]?[\d.,]+$/.test(value) || !/\d/.test(value)) return null;
  if (value.startsWith('-')) { negative = !negative; value = value.slice(1); }
  else if (value.startsWith('+')) value = value.slice(1);

  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  let decimalAt = -1;
  if (comma >= 0 && dot >= 0) {
    const last = Math.max(comma, dot);
    const trailing = value.length - last - 1;
    if (trailing > 0 && trailing <= 2) decimalAt = last;
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : '';
    if (separator) {
      const occurrences = value.split(separator).length - 1;
      const last = value.lastIndexOf(separator);
      const trailing = value.length - last - 1;
      if (occurrences === 1 && trailing > 0 && trailing <= 2) decimalAt = last;
    }
  }

  const scale = decimalAt >= 0 ? value.length - decimalAt - 1 : 0;
  const digits = value.split('').filter((character, index) => /\d/.test(character) && index !== decimalAt).join('');
  if (!digits) return null;
  const magnitude = digits.replace(/^0+(?=\d)/, '');
  const units = negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
  return { units, scale };
};

const exactMagnitude = units => String(units || '0').replace(/^-/, '').replace(/^0+(?=\d)/, '');
const compareExactMagnitudes = (left, right) => left.length !== right.length ? left.length - right.length : left.localeCompare(right);
const addExactMagnitudes = (left, right) => {
  let carry = 0;
  let result = '';
  for (let index = 1; index <= Math.max(left.length, right.length); index += 1) {
    const total = Number(left[left.length - index] || 0) + Number(right[right.length - index] || 0) + carry;
    result = String(total % 10) + result;
    carry = Math.floor(total / 10);
  }
  return `${carry || ''}${result}`.replace(/^0+(?=\d)/, '');
};
const subtractExactMagnitudes = (left, right) => {
  let borrow = 0;
  let result = '';
  for (let index = 1; index <= left.length; index += 1) {
    let digit = Number(left[left.length - index] || 0) - borrow - Number(right[right.length - index] || 0);
    if (digit < 0) { digit += 10; borrow = 1; } else borrow = 0;
    result = String(digit) + result;
  }
  return result.replace(/^0+(?=\d)/, '');
};
const addExactUnits = (leftInput, rightInput) => {
  const left = String(leftInput || '0');
  const right = String(rightInput || '0');
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  const leftMagnitude = exactMagnitude(left);
  const rightMagnitude = exactMagnitude(right);
  if (leftNegative === rightNegative) {
    const result = addExactMagnitudes(leftMagnitude, rightMagnitude);
    return leftNegative && result !== '0' ? `-${result}` : result;
  }
  const comparison = compareExactMagnitudes(leftMagnitude, rightMagnitude);
  if (comparison === 0) return '0';
  const leftLarger = comparison > 0;
  const result = subtractExactMagnitudes(leftLarger ? leftMagnitude : rightMagnitude, leftLarger ? rightMagnitude : leftMagnitude);
  const negative = leftLarger ? leftNegative : rightNegative;
  return negative && result !== '0' ? `-${result}` : result;
};
const scaleExactUnits = (units, places) => {
  const value = String(units || '0');
  if (value === '0') return value;
  return `${value}${'0'.repeat(Math.max(0, places))}`;
};
const sumExactDecimals = values => {
  const scale = Math.max(0, ...values.map(value => value.scale));
  return { scale, units: values.reduce((total, value) => addExactUnits(total, scaleExactUnits(value.units, scale - value.scale)), '0') };
};

const subtractExactDecimals = (left, right) => {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = scaleExactUnits(left.units, scale - left.scale);
  const rightUnits = scaleExactUnits(right.units, scale - right.scale);
  const negativeRight = rightUnits.startsWith('-') ? rightUnits.slice(1) : `-${rightUnits}`;
  return { scale, units: addExactUnits(leftUnits, negativeRight) };
};

const formatExactDecimal = value => {
  const negative = String(value.units).startsWith('-');
  const digits = exactMagnitude(value.units).padStart(value.scale + 1, '0');
  const integer = digits.slice(0, digits.length - value.scale || digits.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = value.scale ? digits.slice(-value.scale).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
};

export { parseExactDecimal, exactMagnitude, compareExactMagnitudes, addExactMagnitudes, subtractExactMagnitudes, addExactUnits, scaleExactUnits, sumExactDecimals, subtractExactDecimals, formatExactDecimal };
