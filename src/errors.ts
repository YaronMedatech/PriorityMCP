/**
 * An error caused by the CALLER's arguments, before Priority was contacted.
 *
 * Kept apart from a Priority failure because the two call for opposite
 * responses and the tool wrapper used to word both as "Priority call failed."
 * A model told that is being told something false: sending 'choose' to a step
 * that wants 'input' never reached the ERP. Believing it did, the model can
 * report an outage, retry a call that will fail identically, or tell the user
 * Priority is down -- all from a mistake it could have corrected itself.
 */
export class CallerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallerError";
  }
}
