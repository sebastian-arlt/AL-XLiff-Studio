'use strict';
// Deterministic cancellation fixture: CPU work never completes on its own.
while (true) { Math.sqrt(123456789); }
