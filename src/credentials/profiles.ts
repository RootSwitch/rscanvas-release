// Credential profiles: what one is, and what the operator may not do to one.
//
// The rules live here, pure, so tools/test-credentials.ts holds them without a
// database. The route validates through this and nothing else.

import { resolveAuthProto, resolvePrivProto, desUsable, type V3Level } from './v3.ts';

export type SnmpVersion = '1' | '2c' | '3';
export type { V3Level };

/** What the operator submits. Secret fields arrive plaintext over TLS and are
 *  encrypted before they touch the store; they never come BACK out through
 *  the API. */
export interface ProfileInput {
    name: string;
    version: SnmpVersion;
    community?: string | null;
    v3User?: string | null;
    v3Level?: V3Level | null;
    v3AuthProto?: string | null;
    v3AuthKey?: string | null;
    v3PrivProto?: string | null;
    v3PrivKey?: string | null;
}

/** What the API returns. NO secret fields - only whether each is set. */
export interface ProfileView {
    id: string;
    name: string;
    version: SnmpVersion;
    hasCommunity: boolean;
    v3User: string | null;
    v3Level: V3Level | null;
    v3AuthProto: string | null;
    hasV3AuthKey: boolean;
    v3PrivProto: string | null;
    hasV3PrivKey: boolean;
    /** How many devices reference this profile by name. */
    devices: number;
    /** False when the stored ciphertext does not decrypt under the current
     *  key - the wrong-key recovery case, named per profile. */
    decryptable: boolean;
    createdTs: Date;
    updatedTs: Date;
}

/**
 * THE NAME RULE. Operator-chosen, non-empty, and never derived from anything.
 * The parent product the operator was escaping auto-named profiles after the
 * first device that used them; nothing in this module accepts a name it did
 * not receive from the request body, and the test proves the add-device path
 * cannot reach here at all.
 *
 * Constrained to a shape that survives being a credential_ref, an env-var-
 * like token and a UI label: letters, digits, dash, underscore, dot. Case is
 * preserved and significant. 1..64 chars.
 */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * THE ENVIRONMENT-REFERENCE RULE, and the reason it lives here rather than at
 * the three places that need it.
 *
 * `credential_ref` names EITHER a profile in the store OR an environment
 * variable on the server. The env half is deliberately narrow - the
 * convention is stated to the operator in crypto.ts ("Env-named credential
 * references (SNMP_COMMUNITY_*) keep working without it") - and until
 * 2026-08-31 the narrowness was enforced NOWHERE.
 *
 * The rule existed in three places and the one that mattered did not have it:
 * main.ts filtered which names the Credentials picker OFFERS, main.ts decided
 * whether a ref REPORTS as resolvable, and the collector - the only site that
 * actually calls process.env[ref] and puts the answer on the wire - tested
 * nothing. So an admin could name RSCANVAS_SECRET, ADMIN_PASSWORD or
 * DATABASE_URL as a device's community and have the collector send it, in
 * cleartext UDP, to any host they chose. The credential store encrypts every
 * profile under RSCANVAS_SECRET, so reading that one variable from inside the
 * application defeats the store entirely.
 *
 * ONE EXPORTED PREDICATE, not three regexes, because three copies of a rule
 * is what produced the hole: two of them agreed and the third had never heard
 * of it. This is the same class as the reach_check dispatch (section 6) - a
 * constraint the doc comments describe and the enforcing site never learned.
 *
 * Scope note: this governs the ENV half only. A profile may be named anything
 * NAME_RE allows, including a name that looks nothing like this, because a
 * profile's secret was typed by an operator into the store rather than read
 * out of the service environment. Callers must therefore check profiles
 * FIRST and consult this only when falling through to process.env.
 */
export const ENV_REF_RE = /^SNMP_COMMUNITY[A-Z0-9_]*$/;

/** Whether `ref` may be resolved against the process environment at all. */
export function isPermittedEnvRef(ref: string): boolean {
    return ENV_REF_RE.test(ref);
}

export type Validation =
    | { ok: true; profile: ProfileInput; warning?: string }
    | { ok: false; detail: string };

// `desAvailable` exists only so the test can exercise both sides of the
// DES-in-the-legacy-provider refusal on a machine that only has one of them.
// Production never passes it.
export function validateProfile(body: Record<string, unknown>, desAvailable: boolean = desUsable()): Validation {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return { ok: false, detail: 'a profile needs a name, and it is yours to choose' };
    if (!NAME_RE.test(name)) {
        return { ok: false, detail: `"${name}" is not a usable profile name - letters, digits, dot, dash and underscore, 1 to 64 characters, starting with a letter or digit` };
    }
    const version = body.version === '1' ? '1' : body.version === '3' ? '3' : body.version === '2c' ? '2c' : null;
    if (version === null) return { ok: false, detail: 'version must be 1, 2c or 3' };

    if (version !== '3') {
        const community = typeof body.community === 'string' ? body.community : '';
        if (community === '') return { ok: false, detail: `SNMP v${version} needs a community string` };
        return { ok: true, profile: { name, version, community } };
    }

    const v3User = typeof body.v3User === 'string' ? body.v3User.trim() : '';
    if (v3User === '') return { ok: false, detail: 'SNMPv3 needs a user name' };
    const level = body.v3Level === 'noAuthNoPriv' || body.v3Level === 'authNoPriv' || body.v3Level === 'authPriv'
        ? body.v3Level : null;
    if (level === null) return { ok: false, detail: 'v3Level must be noAuthNoPriv, authNoPriv or authPriv' };
    const authKey = typeof body.v3AuthKey === 'string' ? body.v3AuthKey : '';
    const privKey = typeof body.v3PrivKey === 'string' ? body.v3PrivKey : '';
    if (level !== 'noAuthNoPriv' && authKey === '') return { ok: false, detail: `${level} needs an auth key` };
    if (level === 'authPriv' && privKey === '') return { ok: false, detail: 'authPriv needs a priv key' };

    // PROTOCOLS ARE RESOLVED AT THE WRITE PATH (slice 29), not at poll time.
    // A typo stored is a profile that looks configured and fails as "wrong
    // digest" against a device where nothing is wrong - the operator then
    // debugs the agent. Resolving here means the refusal names the typo and
    // lists what exists, and the stored value is the library's own key so
    // the collector indexes rather than interprets.
    const auth = level === 'noAuthNoPriv' ? null : resolveAuthProto(
        typeof body.v3AuthProto === 'string' ? body.v3AuthProto : null);
    if (auth !== null && !auth.ok) return { ok: false, detail: auth.detail };
    const priv = level !== 'authPriv' ? null : resolvePrivProto(
        typeof body.v3PrivProto === 'string' ? body.v3PrivProto : null, desAvailable);
    if (priv !== null && !priv.ok) return { ok: false, detail: priv.detail };

    return {
        ok: true,
        profile: {
            name, version, v3User, v3Level: level,
            v3AuthProto: auth !== null && auth.ok ? auth.key : null,
            v3AuthKey: authKey || null,
            v3PrivProto: priv !== null && priv.ok ? priv.key : null,
            v3PrivKey: privKey || null,
        },
        // Named, never refused: the operator's v3-only BMCs may speak
        // nothing better, and a fork that refuses them monitors nothing
        // instead of monitoring something with a caveat.
        ...((auth !== null && auth.ok && auth.weak) || (priv !== null && priv.ok && priv.weak)
            ? {
                warning: `${[auth?.ok && auth.weak ? auth.label : '', priv?.ok && priv.weak ? priv.label : '']
                    .filter(Boolean).join(' and ')} is broken cryptography - accepted because some `
                    + 'devices offer nothing else, but prefer SHA-256 and AES where the agent allows it.',
            }
            : {}),
    };
}
