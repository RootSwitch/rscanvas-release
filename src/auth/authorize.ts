// Authorisation, separated from authentication.
//
// ARCHITECTURE.md section 3: one function, `authorize(principal, action,
// resource)`, is the only place a permission decision is made. That is what
// "OIDC-ready" has to mean concretely - adding an identity provider later
// replaces the authentication half and touches nothing else. If permission
// checks are scattered through handlers, swapping how people prove who they are
// means auditing every one of them.
//
// The other half of the reason is the parent suite's shape. Retrofitting
// per-board authorisation onto a single-board assumption would touch storage,
// routing, UI and the status feeds at once, which is the one-way-door shape
// handoff section 0b warns about. Slices 7 and 8 add boards and capability
// tokens as resources; they extend the table below and nothing else.

export type Role = 'viewer' | 'operator' | 'admin';

export const ROLES: readonly Role[] = ['viewer', 'operator', 'admin'] as const;

export function isRole(v: unknown): v is Role {
    return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

/**
 * Two kinds of principal, coexisting rather than competing (section 3).
 *
 * People authenticate as themselves and are authorised by role. Displays
 * authenticate with a capability token, because a wall display cannot log in
 * and the network segment is not an access control. Slice 8 builds the display
 * kind; it is declared here so that adding it is a new variant rather than a
 * change to the shape of every call site.
 */
export type Principal =
    | { kind: 'user'; id: number; username: string; role: Role }
    | { kind: 'display'; tokenId: number; boardId: number; label: string }
    | { kind: 'anonymous' };

// Actions are named for what they DO, not for the route that happens to
// perform them. A route is an implementation detail and it changes; "may this
// principal read syslog" does not.
export type Action =
    | 'health.read'
    | 'syslog.read'
    | 'alerts.read'
    | 'devices.read'
    | 'syslog.export'
    | 'user.read'
    | 'user.create'
    | 'user.delete'
    | 'user.setRole'
    | 'user.setPasswordOwn'
    | 'user.setPasswordAny'
    | 'audit.read'
    // Retention is split in two because the two questions have different
    // blast radii even though neither one drops anything. Reading the
    // inventory is a report; asking the guarded function what it WOULD do
    // takes the same advisory lock the real hourly run wants, so a careless
    // caller can make retention skip an hour. Separate actions keep that
    // distinction available to a future role that should see the page
    // without being able to poke the machinery.
    | 'retention.read'
    | 'retention.preview'
    // Boards. `board.render` is the ONLY action a display principal may ever
    // hold, and it is deliberately not called board.read: reading a board
    // means the document, rendering it means the projection, and
    // BOARD-EXPOSURE.md turns on that distinction. Naming the action for the
    // narrow thing is what stops a later route reusing it for the wide one.
    | 'board.read'
    | 'board.write'
    | 'board.render'
    | 'token.mint'
    | 'token.revoke'
    // Editing a device's grouping is the first DEVICE mutation in the
    // product. Named for what it does rather than "device.write", because a
    // later action that changes an address or a credential ref is a very
    // different risk and must not inherit this permission by sharing a name.
    | 'device.group'
    // Adding a device is not editing one. It creates a poller target and a
    // credential reference, and at scale it creates hundreds - so it is named
    // apart from device.group and given only to admins.
    | 'device.create'
    // Event alert rules (slice 10). Read is operator-and-up: patterns are
    // operator content, not secrets, but they shape what pages - a viewer
    // watches alerts, an operator understands why they exist. Write is
    // admin: a rule's pattern runs on the INGEST THREAD per message, so
    // authoring one is a change to the hot path - the same trust level as
    // creating devices.
    | 'alertrule.read'
    | 'alertrule.write'
    // A credential profile is a SECRET the collector will send on the wire to
    // every device that names it. Reading the list is admin (it reveals which
    // profiles exist and how many devices use each, never the secret); writing
    // one is admin because it is the same trust as creating devices - and
    // strictly more, since a profile can be pointed at devices already there.
    | 'credential.read'
    | 'credential.write'
    // Disabling stops the poller; deleting destroys the row and its entities.
    // Separate actions because the errors run opposite ways - the same
    // reasoning that gave operators token.revoke without token.mint - and a
    // future role that may quiet a noisy device should not thereby be able to
    // erase it.
    | 'device.disable'
    | 'device.delete'
    // Tracking is what turns an interface or sensor into alerts and history.
    // Untracking is the same shift work as device.disable - quieting a source
    // that is telling you nothing, reversible with one click - so it sits at
    // the same level: operator and up, never viewer.
    | 'device.track'
    // A speed override replaces an advertised NIC speed the measurement has
    // disproven (virtio and Hyper-V lie routinely) so utilization alerting
    // can resume against a number a human vouches for. Same family as
    // disable and track: reversible shift work, never viewer.
    | 'device.speed'
    // Renaming changes the identity every name-keyed row hangs on: open
    // alerts, their keys, host-scoped threshold overrides, and the audit
    // trail's targets from here on. Reversible in principle, wide in
    // effect - an admin act like create and delete, not shift work.
    | 'device.rename'
    // Moving a device to another address (or SNMP port) keeps its identity
    // and history and changes where every poll and probe goes from the next
    // tick on. Same class as rename: reversible in principle, wide in
    // effect, admin.
    | 'device.address'
    // A maintenance window withholds NOTIFICATION for a named set with a
    // required end time; the alerts themselves raise and display normally.
    // Reversible, self-expiring shift work - the same family as
    // device.disable and device.track: operator and up, never viewer.
    | 'alert.suppress'
    // Muting a device (2026-09-25, operator request) stops its polled alerts
    // from RAISING at all - device-down, interfaces, sensors - where
    // alert.suppress only withholds delivery. Untracking an interface is the
    // per-row version of the same act and is already operator work, and the
    // device keeps being polled and charted, so it sits with device.track:
    // reversible with one click, operator and up, never viewer.
    | 'device.mute'
    // A service check (slice 58) makes RSCanvas fetch a URL or open a port
    // of the author's choosing, from inside the network, on a schedule -
    // the same power as adding a device, so the same role: admin. Pausing
    // one is device.track (an untrack, operator and up), as for a sensor.
    | 'check.write';

export interface Resource {
    type: 'system' | 'user' | 'syslog' | 'board';
    /** For a user resource: the username being acted upon. */
    id?: string;
}

export interface Decision {
    allowed: boolean;
    /** Present when denied. Safe to show a user: it says what is required. */
    reason?: string;
}

const ALLOW: Decision = { allowed: true };
const deny = (reason: string): Decision => ({ allowed: false, reason });

// What each role may do. Ascending, and cumulative by construction rather than
// by inheritance, because "operator inherits viewer" is the kind of implicit
// rule that later grows an exception nobody notices.
const BY_ROLE: Record<Role, ReadonlySet<Action>> = {
    viewer: new Set<Action>([
        'health.read',
        'syslog.read',
        'alerts.read',
        'devices.read',
        'user.setPasswordOwn',
        'board.read',
        'board.render',
    ]),
    operator: new Set<Action>([
        'health.read',
        'syslog.read',
        'alerts.read',
        'devices.read',
        'syslog.export',
        'user.setPasswordOwn',
        'board.read',
        'board.write',
        'board.render',
        // An operator may QUIET a device - that is shift work, and it is
        // reversible. Deleting is not theirs.
        'device.disable',
        'device.track',
        'device.speed',
        'device.mute',
        'alert.suppress',
        // Tagging is the operator's job - they are the ones who know which
        // rack a switch is in and which application a server serves. A viewer
        // reads the grouping and cannot set it.
        'device.group',
        'alertrule.read',
        // NOT token.mint - issuing a credential that renders a board from
        // anywhere, with no human attached, is an admin act.
        //
        // BUT YES token.revoke, and the asymmetry is the point. Revocation
        // REMOVES access, and the two errors run in opposite directions: a
        // token minted in error is a live credential in the world, while a
        // token revoked in error is a blank screen that somebody re-mints in
        // thirty seconds. Requiring an admin to kill a leaked token at 2am
        // makes the safe action the expensive one, which is how leaked
        // credentials end up living until morning.
        'token.revoke',
    ]),
    admin: new Set<Action>([
        'health.read',
        'syslog.read',
        'alerts.read',
        'devices.read',
        'syslog.export',
        'user.read',
        'user.create',
        'user.delete',
        'user.setRole',
        'user.setPasswordOwn',
        'user.setPasswordAny',
        'device.create',
        'check.write',
        'device.disable',
        'device.delete',
        'device.track',
        'device.speed',
        'device.mute',
        'device.rename',
        'device.address',
        'alert.suppress',
        'alertrule.read',
        'alertrule.write',
        'credential.read',
        'credential.write',
        'audit.read',
        'retention.read',
        'retention.preview',
        'board.read',
        'board.write',
        'board.render',
        'device.group',
        // Minting a capability token creates a credential that works from
        // anywhere with no human attached. That is an admin act, and it is
        // separated from revocation deliberately - see the note in the
        // display branch below about which way each error runs.
        'token.mint',
        'token.revoke',
    ]),
};

/**
 * The only place a permission decision is made.
 *
 * Default deny: an action absent from a role's set is refused, so adding an
 * Action to the union without adding it to a role makes that action
 * unreachable rather than universally permitted. The type checker will not
 * catch the omission, but the failure mode is a locked door rather than an open
 * one, which is the right way round.
 */
export function authorize(
    principal: Principal, action: Action, resource: Resource = { type: 'system' },
): Decision {
    if (principal.kind === 'anonymous') {
        return deny('authentication required');
    }

    if (principal.kind === 'display') {
        // A capability token may do EXACTLY ONE THING: render the one board it
        // was minted for. Everything else - reading the document, listing
        // boards, reading devices or syslog or health - is refused here, in
        // the single place a permission decision is made.
        //
        // Written as an allow-list of one rather than a deny-list, so a new
        // Action added to the union next year is refused for displays by
        // omission. The alternative fails open exactly once and silently.
        if (action !== 'board.render') {
            return deny('a display token may only render its own board');
        }
        // CLAUSE 2, ENFORCED HERE: the board must be the token's own. The
        // caller passes the board id it is about to serve; if that did not
        // come from the token, this is where it stops. A display cannot name
        // a board - it presents a credential and is told which one it has.
        if (resource.type !== 'board' || resource.id !== String(principal.boardId)) {
            return deny('a display token is scoped to the board it was minted for');
        }
        return ALLOW;
    }

    // Disabled accounts are refused at authentication, not here. This function
    // decides what a role may do, and keeping account state out of it is what
    // keeps it a pure function of (role, action, resource).

    if (!BY_ROLE[principal.role].has(action)) {
        return deny(`role ${principal.role} may not ${action}`);
    }

    // Resource-scoped rules, after the role check rather than instead of it.
    if (action === 'user.setPasswordOwn') {
        if (resource.type !== 'user' || resource.id === undefined) {
            return deny('user.setPasswordOwn needs the target user');
        }
        if (resource.id !== principal.username) {
            // Changing someone else's password is a different action with a
            // different permission, so the answer here is no regardless of role.
            return deny('user.setPasswordOwn is only for your own account; use user.setPasswordAny');
        }
    }

    if (action === 'user.delete' && resource.type === 'user' && resource.id === principal.username) {
        // Not a permission question so much as a foot-gun: an admin deleting
        // themselves can lock everyone out. The last-admin rule is enforced in
        // the store as well, because that one is a data invariant.
        return deny('an admin cannot delete their own account');
    }

    if (action === 'user.setRole' && resource.type === 'user' && resource.id === principal.username) {
        return deny('an admin cannot change their own role');
    }

    return ALLOW;
}

/** Convenience for handlers: throws nothing, returns the decision to render. */
export function can(principal: Principal, action: Action, resource?: Resource): boolean {
    return authorize(principal, action, resource).allowed;
}

/**
 * The actions a role holds, for the web client to decide which CONTROLS to
 * show (2026-09-25). This is not the access control - every route still asks
 * authorize() - it is the difference between a door that is locked and a
 * door that is not advertised. The client used to know only "admin or not",
 * so operator controls hid from operators and viewers were shown forms the
 * server then refused. Read from BY_ROLE, the table authorize() itself
 * uses, so the page and the server cannot disagree about a role.
 */
export function actionsFor(role: Role): Action[] {
    return [...BY_ROLE[role]].sort();
}
