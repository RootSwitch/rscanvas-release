// Copy to tools/screenshots.local.mjs (ignored by git) and fill in the lab
// the screenshots are captured in. SCRUB rewrites; LEFTOVER must never appear.
export const SCRUB = [
    // The lab's segment, read as the IT admin's laptop on the HQ floor.
    [/\b198\.51\.100\.\d{1,3}\b/g, '10.20.20.52'],
    // The lab box's own name, read as the monitoring server.
    [/\blab-box-\d\b/g, 'mon-01'],
];
export const LEFTOVER = [/\blab-box-\d/, /\byour-surname\b/i];
