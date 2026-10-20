const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function toLatinDigits(input: string) {
  return input
    .replace(/[۰-۹]/g, (digit) => String(FA_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(AR_DIGITS.indexOf(digit)));
}

export function normalizeNationalId(input: string) {
  const digits = toLatinDigits(input.trim()).replace(/\D/g, '');
  if (digits.length === 9) return digits.padStart(10, '0');
  return digits;
}

export function isValidIranianNationalId(input: string) {
  const id = normalizeNationalId(input);
  if (!/^\d{10}$/.test(id) || /^(\d)\1{9}$/.test(id)) {
    return false;
  }
  const check = Number(id[9]);
  const sum = id
    .slice(0, 9)
    .split('')
    .reduce((total, digit, index) => total + Number(digit) * (10 - index), 0);
  const remainder = sum % 11;
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

export function normalizePhone(input: string) {
  return toLatinDigits(input.trim()).replace(/[\s-]/g, '');
}

export function normalizeMobile(input: string) {
  let phone = normalizePhone(input).replace(/\D/g, '');
  if (phone.startsWith('0098')) phone = phone.slice(4);
  else if (phone.startsWith('98') && phone.length >= 12) phone = phone.slice(2);
  if (phone.startsWith('9') && phone.length === 10) phone = `0${phone}`;
  return phone;
}

export function phoneLookupValues(input: string) {
  const normalized = normalizeMobile(input);
  if (!normalized) return [];
  const values = new Set<string>([normalized, normalizePhone(input)]);
  if (normalized.startsWith('0') && normalized.length === 11) {
    values.add(normalized.slice(1));
  }
  return [...values].filter(Boolean);
}

export function joinFullName(firstName: string, lastName: string) {
  return `${firstName.trim()} ${lastName.trim()}`.trim();
}

export function randomTempPassword() {
  return `Aa${Math.random().toString(36).slice(2, 8)}1!`;
}
