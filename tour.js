// procfunc.io tour engine.
// Scenes are SVG state machines driven by timers; CSS does the
// tweening. Signals — cancellation, errors, payloads — are dots that
// travel along edges, because in proc everything is a message.
// Without JavaScript, the prose and code carry the page.

"use strict";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Theme toggle: system → dark → light ----------

{
    const toggle = document.getElementById("theme-toggle");
    const icons = { system: "◐", dark: "●", light: "○" };
    const order = { system: "dark", dark: "light", light: "system" };
    const paint = () => {
        const t = document.documentElement.dataset.theme || "system";
        toggle.textContent = icons[t];
        toggle.setAttribute("aria-label", `Theme: ${t}`);
        toggle.title = `Theme: ${t}`;
    };
    toggle.addEventListener("click", () => {
        const root = document.documentElement;
        const next = order[root.dataset.theme || "system"];
        if (next === "system") {
            delete root.dataset.theme;
            try { localStorage.removeItem("theme"); } catch { }
        } else {
            root.dataset.theme = next;
            try { localStorage.setItem("theme", next); } catch { }
        }
        paint();
    });
    paint();
}

// ---------- Syntax highlighting ----------

{
    const rules = new RegExp(
        "(\\/\\/[^\\n]*)" +
        "|(`[^`]*`|\"(?:[^\"\\\\\\n]|\\\\.)*\")" +
        "|\\b(func|return|defer|go|package|import|for|range|if|else" +
        "|switch|case|select|chan|map|struct|interface|type|var|const" +
        "|new|make|nil)\\b",
        "g");
    for (const code of document.querySelectorAll("pre code")) {
        const src = code.textContent;
        let out = "", last = 0;
        for (const m of src.matchAll(rules)) {
            out += esc(src.slice(last, m.index));
            const cls = m[1] ? "c" : m[2] ? "s" : "k";
            out += `<span class="${cls}">${esc(m[0])}</span>`;
            last = m.index + m[0].length;
        }
        out += esc(src.slice(last));
        code.innerHTML = out;
    }
    function esc(s) {
        return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

// ---------- SVG helpers ----------

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, text) {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
}

// State glyphs, so states read by shape as well as color.
const glyphs = {
    crashed: "✕",
    canceled: "⊘",
    backoff: "↻",
};

// A proc node: circle + state glyph + label beneath + sub-label.
function proc(x, y, label, opts = {}) {
    const g = el("g", { class: "proc", "data-state": opts.state || "hidden" });
    g.setAttribute("transform", `translate(${x} ${y})`);
    const r = opts.r || 20;
    g.appendChild(el("circle", { class: "body", r }));
    const glyph = el("text", { class: "glyph", y: 5 }, "");
    g.appendChild(glyph);
    const dy = opts.dy || 0;
    if (label) g.appendChild(el("text", { class: "n-label", y: r + 20 + dy }, label));
    const sub = el("text", { class: "n-sub", y: r + 34 + dy }, opts.sub || "");
    g.appendChild(sub);
    g.state = (s, gl) => {
        g.setAttribute("data-state", s);
        glyph.textContent = gl !== undefined ? gl : (glyphs[s] || "");
    };
    g.sub = t => { sub.textContent = t; };
    return g;
}

// A supervision root: rounded rect, proc.Context unless named.
function ctxRoot(x, y, label = "proc.Context") {
    const g = el("g");
    g.setAttribute("transform", `translate(${x} ${y})`);
    g.appendChild(el("rect", {
        x: -70, y: -16, width: 140, height: 32, rx: 8,
        fill: "var(--bg)", stroke: "var(--accent)", "stroke-width": 1.5,
    }));
    g.appendChild(el("text", { class: "n-label", y: 4 }, label));
    const sub = el("text", { class: "n-sub", y: 34 }, "");
    g.appendChild(sub);
    g.sub = t => { sub.textContent = t; };
    return g;
}

function edge(x1, y1, x2, y2, hidden) {
    const e = el("path", {
        class: "edge",
        d: `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`,
    });
    if (hidden) e.setAttribute("opacity", 0);
    return e;
}

// An invisible rail for signals to travel along.
function rail(x1, y1, x2, y2) {
    return el("path", {
        d: `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`,
        fill: "none",
    });
}

// ---------- Stage: timers with a generation guard ----------

class Stage {
    constructor() { this.gen = 0; this.running = false; this.timers = new Set(); }
    start() { this.running = true; this.gen++; }
    stop() {
        this.running = false;
        this.gen++;
        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();
    }
    after(ms, fn) {
        if (!this.running) return;
        const g = this.gen;
        const t = setTimeout(() => {
            this.timers.delete(t);
            if (this.running && this.gen === g) fn();
        }, reduced ? Math.min(ms, 20) : ms);
        this.timers.add(t);
    }
}

// A signal dot traveling along a path. In proc, cancellation, errors,
// and payloads are all messages; they all move the same way.
function travel(st, svg, pathEl, opts = {}) {
    const node = opts.node ||
        el("circle", { class: "signal " + (opts.cls || ""), r: opts.r || 5 });
    if (!opts.node) svg.appendChild(node);
    const len = pathEl.getTotalLength();
    const dur = reduced ? 1 : opts.dur || 650;
    const gen = st.gen, t0 = performance.now();
    function frame(t) {
        if (!st.running || st.gen !== gen) {
            node.remove();
            return;
        }
        const p = Math.min(1, (t - t0) / dur);
        const pt = pathEl.getPointAtLength((opts.reverse ? 1 - p : p) * len);
        node.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
        if (p < 1) {
            requestAnimationFrame(frame);
        } else {
            if (!opts.node && !opts.keep) node.remove();
            if (opts.onArrive) opts.onArrive(node);
        }
    }
    requestAnimationFrame(frame);
    return node;
}

// ---------- Scene registry ----------

const sims = {};

function scene(id, factory) {
    const svg = document.getElementById("anim-" + id);
    if (svg) sims[id] = factory(svg);
}

// ---------- Hero: the whole story on three hosts ----------

scene("hero", svg => {
    const st = new Stage();

    const lb = el("g");
    lb.appendChild(el("rect", {
        x: 185, y: 16, width: 150, height: 26, rx: 8,
        fill: "var(--bg)", stroke: "var(--accent)", "stroke-width": 1.5,
    }));
    lb.appendChild(el("text", { class: "h-label", x: 260, y: 33 }, "load balancer"));
    svg.appendChild(lb);

    const chan = el("g");
    chan.appendChild(el("rect", {
        class: "chan", x: 110, y: 246, width: 300, height: 30, rx: 8,
    }));
    chan.appendChild(el("text", { class: "h-label", x: 260, y: 296 }, "mail"));
    svg.appendChild(chan);

    const hosts = [];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const g = el("g", { class: "host-g" });
        g.appendChild(el("rect", { class: "host", x, y: 62, width: 150, height: 124, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 83 }, `host-${i + 1}`));
        const http = proc(x + 45, 124, "http", { r: 12, state: "running" });
        const mailer = proc(x + 105, 124, "mail", { r: 12, state: i === 0 ? "running" : "standby" });
        g.appendChild(http);
        g.appendChild(mailer);
        const ring = el("circle", {
            class: "claim-ring", cx: x + 105, cy: 124, r: 19,
            opacity: i === 0 ? 1 : 0,
        });
        g.appendChild(ring);
        svg.appendChild(g);
        const paths = {
            req: rail(260, 42, x + 45, 110),
            deliver: rail(118, 258, x + 105, 124),
        };
        for (const p of Object.values(paths)) svg.appendChild(p);
        hosts.push({ g, http, mailer, ring, paths, dead: false, x });
    }

    let holder = 0, mailSeq = 0;
    const qdots = [];
    const dynRails = new Set();

    function mkdot(num, x, y) {
        const g = el("g", { class: "qdot" });
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.appendChild(el("circle", { r: 8 }));
        g.appendChild(el("text", { y: 3.5 }, String(num)));
        svg.appendChild(g);
        return g;
    }

    // FIFO: new work parks at the right; the head leaves from the left.
    function syncQueue() {
        qdots.forEach((d, i) => {
            d.style.transform = `translate(${132 + i * 26}px, 261px)`;
        });
    }

    function requests() {
        st.after(1100 + Math.random() * 700, () => {
            const alive = hosts.filter(h => !h.dead);
            if (alive.length) {
                const h = alive[Math.floor(Math.random() * alive.length)];
                travel(st, svg, h.paths.req, {
                    cls: "msg", r: 4, dur: 700,
                    onArrive() {
                        if (h.dead) return;
                        // The response, always.
                        travel(st, svg, h.paths.req, {
                            cls: "msg", r: 3, dur: 700, reverse: true,
                        });
                        // Sometimes the request produces mail work,
                        // aimed at the slot it will occupy.
                        if (Math.random() < 0.55 && qdots.length < 5) {
                            mailSeq++;
                            const d = mkdot(mailSeq, h.x + 45, 137);
                            const r = rail(h.x + 45, 137,
                                132 + qdots.length * 26, 261);
                            dynRails.add(r);
                            svg.appendChild(r);
                            travel(st, svg, r, {
                                node: d, dur: 800,
                                onArrive() {
                                    r.remove();
                                    dynRails.delete(r);
                                    d.classList.add("parked");
                                    qdots.push(d);
                                    syncQueue();
                                },
                            });
                        }
                    },
                });
            }
            requests();
        });
    }

    let holding = null;

    function deliveries() {
        st.after(1900, () => {
            const h = hosts[holder];
            if (qdots.length && !h.dead && !holding) {
                // Delivery is a claim: the head dims in place and a
                // copy travels; ack removes it, nak un-dims.
                const orig = qdots[0];
                orig.classList.add("claimed");
                const num = orig.querySelector("text").textContent;
                const copy = mkdot(num, 0, 0);
                copy.style.transform = orig.style.transform;
                const at = holder;
                const release = () => orig.classList.remove("claimed");
                travel(st, svg, h.paths.deliver, {
                    node: copy, dur: 800,
                    onArrive() {
                        if (hosts[at].dead) {
                            travel(st, svg, hosts[at].paths.deliver, {
                                node: copy, dur: 800, reverse: true,
                                onArrive() {
                                    copy.remove();
                                    release();
                                },
                            });
                            return;
                        }
                        holding = { copy, orig, host: at, release };
                        st.after(1300, () => {
                            if (holding && holding.copy === copy) {
                                copy.remove();
                                const i = qdots.indexOf(orig);
                                if (i !== -1) qdots.splice(i, 1);
                                orig.remove();
                                syncQueue();
                                holding = null;
                            }
                        });
                    },
                });
            }
            deliveries();
        });
    }

    function setHolder(i) {
        holder = i;
        hosts.forEach((h, j) => {
            h.ring.setAttribute("opacity", j === i && !h.dead ? 1 : 0);
            if (!h.dead) h.mailer.state(j === i ? "running" : "standby");
        });
    }

    function chaos() {
        st.after(8000 + Math.random() * 3000, () => {
            const alive = hosts.filter(h => !h.dead);
            if (alive.length > 1) {
                const h = alive[Math.floor(Math.random() * alive.length)];
                const i = hosts.indexOf(h);
                h.dead = true;
                h.g.setAttribute("data-dead", "true");
                h.http.state("hidden");
                h.mailer.state("hidden");
                h.ring.setAttribute("opacity", 0);
                if (holding && holding.host === i) {
                    // The unacked copy escapes back; the original
                    // un-dims in place.
                    const { copy, release } = holding;
                    holding = null;
                    travel(st, svg, h.paths.deliver, {
                        node: copy, dur: 800, reverse: true,
                        onArrive() {
                            copy.remove();
                            release();
                        },
                    });
                }
                if (i === holder) {
                    st.after(800, () => {
                        const next = hosts.findIndex(x => !x.dead);
                        if (next !== -1) setHolder(next);
                    });
                }
                st.after(4200, () => {
                    h.dead = false;
                    h.g.setAttribute("data-dead", "false");
                    h.http.state("running");
                    h.mailer.state(hosts.indexOf(h) === holder ? "running" : "standby");
                    if (hosts.indexOf(h) === holder) h.ring.setAttribute("opacity", 1);
                });
            }
            chaos();
        });
    }

    return {
        start() { st.start(); if (!reduced) { requests(); deliveries(); chaos(); } },
        stop() {
            st.stop();
            for (const d of qdots) d.remove();
            qdots.length = 0;
            for (const r of dynRails) r.remove();
            dynRails.clear();
            if (holding) { holding.copy.remove(); holding = null; }
            hosts.forEach(h => {
                h.dead = false;
                h.g.setAttribute("data-dead", "false");
                h.http.state("running");
            });
            setHolder(holder);
        },
    };
});

// ---------- Scope: tree grows; cancel is a message ----------

scene("context", svg => {
    const st = new Stage();
    const root = ctxRoot(260, 60);
    const defs = [
        [120, 196, "pollInventory"],
        [260, 222, "pruneSessions"],
        [400, 196, "reportMetrics"],
    ];
    const edges = [], kids = [];
    for (const [x, y, label] of defs) {
        const e = edge(260, 76, x, y - 20, true);
        edges.push(e);
        svg.appendChild(e);
        const p = proc(x, y, label, { state: reduced ? "running" : "hidden" });
        if (reduced) e.setAttribute("opacity", 1);
        kids.push(p);
        svg.appendChild(p);
    }
    svg.appendChild(root);

    function loop() {
        for (const [i] of kids.entries()) {
            edges[i].setAttribute("opacity", 0);
            kids[i].state("hidden");
        }
        root.sub("");
        kids.forEach((k, i) => st.after(500 + i * 550, () => {
            edges[i].setAttribute("opacity", 1);
            k.state("running");
        }));
        st.after(4400, () => root.sub("cancel()"));
        kids.forEach((k, i) => st.after(4500 + i * 250, () => {
            travel(st, svg, edges[i], {
                cls: "cancel", dur: 550,
                onArrive: () => k.state("canceled"),
            });
        }));
        kids.forEach((k, i) => st.after(6300 + i * 250, () => k.state("retired", "⊘")));
        st.after(7400, () => root.sub("Wait returned"));
        st.after(9400, loop);
    }
    return {
        start() { st.start(); if (!reduced) loop(); },
        stop() { st.stop(); },
    };
});

// ---------- Fail-fast: the error is a message to the root ----------

scene("wait", svg => {
    const st = new Stage();
    const root = ctxRoot(260, 60);
    const defs = [[120, 196, "migrate"], [260, 222, "preload"], [400, 196, "inspect"]];
    const edges = [], kids = [];
    for (const [x, y, label] of defs) {
        const e = edge(260, 76, x, y - 20);
        edges.push(e);
        svg.appendChild(e);
        const p = proc(x, y, label, { state: "running" });
        kids.push(p);
        svg.appendChild(p);
    }
    svg.appendChild(root);
    if (reduced) {
        kids[2].state("crashed");
        kids[0].state("canceled");
        kids[1].state("canceled");
        root.sub("Wait → err");
    }

    let round = 0;
    function loop() {
        for (const k of kids) k.state("running");
        root.sub("");
        round++;
        if (round % 2 === 1) {
            // Everything finishes; Wait returns nil.
            kids.forEach((k, i) => st.after(2000 + i * 700, () => {
                k.state("retired", "✓");
            }));
            st.after(4600, () => root.sub("Wait → nil"));
            st.after(7600, loop);
            return;
        }
        st.after(2400, () => kids[2].state("crashed"));
        st.after(2800, () => {
            travel(st, svg, edges[2], {
                cls: "err", dur: 550, reverse: true,
                onArrive() {
                    root.sub("Wait → err");
                    [0, 1].forEach((i, j) => st.after(150 + j * 200, () => {
                        travel(st, svg, edges[i], {
                            cls: "cancel", dur: 550,
                            onArrive: () => kids[i].state("canceled"),
                        });
                    }));
                },
            });
        });
        st.after(5300, () => {
            kids[0].state("retired", "⊘");
            kids[1].state("retired", "⊘");
            kids[2].state("retired", "✕");
        });
        st.after(8000, loop);
    }
    return {
        start() { st.start(); if (!reduced) loop(); },
        stop() { st.stop(); },
    };
});

// ---------- Keep: crash, decay backoff, restart ----------

scene("keep", svg => {
    const st = new Stage();
    const root = ctxRoot(260, 60, "proc.Keep");
    const e = edge(260, 76, 260, 164);
    svg.appendChild(e);
    const p = proc(260, 190, "watchQueue", { state: "running", r: 26 });
    svg.appendChild(root);
    svg.appendChild(p);
    const R = 36, C = 2 * Math.PI * R;
    const ring = el("circle", {
        class: "backoff-ring", cx: 260, cy: 190, r: R,
        "stroke-dasharray": C, "stroke-dashoffset": 0, opacity: 0,
        transform: "rotate(-90 260 190)",
    });
    svg.appendChild(ring);
    const btn = document.querySelector('#keep .ctl[data-act="crash"]');

    // Decay backoff, the library's shape: a crash after a long run is
    // free; only failures in quick succession grow the wait.
    const backoffs = [0, 1200, 2600, 5200];
    let state = "running", streak = 0, runStart = performance.now();

    function setState(s) {
        state = s;
        if (btn) btn.disabled = s !== "running";
    }

    function crash() {
        if (state !== "running" || !st.running) return;
        const lived = performance.now() - runStart;
        if (lived > 5000) streak = 0;
        const wait = backoffs[streak];
        streak = Math.min(streak + 1, backoffs.length - 1);
        setState("crashed");
        p.state("crashed");
        travel(st, svg, e, {
            cls: "err", dur: 450, reverse: true,
            onArrive: () => root.sub(wait ? "err → backoff" : "err → restart"),
        });
        st.after(1000, () => {
            if (!wait) {
                restart();
                return;
            }
            setState("backoff");
            p.state("backoff");
            p.sub(`restart in ${(wait / 1000).toFixed(1)}s`);
            ring.setAttribute("opacity", 1);
            ring.style.transition = "none";
            ring.style.strokeDashoffset = "0";
            void ring.getBoundingClientRect();
            ring.style.transition = `stroke-dashoffset ${wait}ms linear`;
            ring.style.strokeDashoffset = String(C);
            st.after(wait, restart);
        });
    }

    function restart() {
        ring.setAttribute("opacity", 0);
        p.state("running");
        p.sub("");
        st.after(1000, () => root.sub(""));
        runStart = performance.now();
        // A short cooldown before the button re-arms, so crash-looping
        // the demo takes deliberate clicks rather than a queue.
        setState("cooldown");
        st.after(900, () => { if (state === "cooldown") setState("running"); });
    }

    function ambient(delay) {
        st.after(delay, () => {
            crash();
            ambient(8000 + Math.random() * 3000);
        });
    }
    return {
        start() { st.start(); restart(); streak = 0; if (!reduced) ambient(3800); },
        stop() { st.stop(); ring.setAttribute("opacity", 0); p.state("running"); p.sub(""); },
        acts: { crash },
    };
});

// ---------- Solo: claim migration across hosts ----------

scene("solo", svg => {
    const st = new Stage();
    const hosts = [];
    let holder = 0, idleKill = null;
    const RR = 9, RC = 2 * Math.PI * RR;

    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const g = el("g", {
            class: "host-g", role: "button", tabindex: 0,
            "aria-label": `Kill host-${i + 1}`,
        });
        g.appendChild(el("rect", { class: "host", x, y: 55, width: 150, height: 190, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 79 }, `host-${i + 1}`));
        const hsub = el("text", { class: "h-sub", x: x + 75, y: 95 }, "");
        g.appendChild(hsub);
        const reboot = el("circle", {
            class: "backoff-ring", cx: x + 132, cy: 75, r: RR,
            "stroke-dasharray": RC, "stroke-dashoffset": 0, opacity: 0,
            transform: `rotate(-90 ${x + 132} 75)`,
        });
        g.appendChild(reboot);
        const p = proc(x + 75, 150, "mailer", { state: i === 0 ? "running" : "standby" });
        p.sub(i === 0 ? "holds claim" : "standby");
        g.appendChild(p);
        const ring = el("circle", {
            class: "claim-ring", cx: x + 75, cy: 150, r: 28,
            opacity: i === 0 ? 1 : 0,
        });
        g.appendChild(ring);
        svg.appendChild(g);
        hosts.push({ g, p, ring, hsub, reboot, dead: false });
        g.addEventListener("click", () => kill(i));
        g.addEventListener("keydown", ev => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); kill(i); }
        });
    }

    function setHolder(i) {
        holder = i;
        hosts.forEach((h, j) => {
            h.ring.setAttribute("opacity", j === i && !h.dead ? 1 : 0);
            if (!h.dead) {
                h.p.state(j === i ? "running" : "standby");
                h.p.sub(j === i ? "holds claim" : "standby");
            }
        });
    }

    function kill(i) {
        const h = hosts[i];
        if (h.dead || !st.running) return;
        scheduleIdleKill();
        h.dead = true;
        h.g.setAttribute("data-dead", "true");
        h.p.state("hidden");
        h.p.sub("");
        h.ring.setAttribute("opacity", 0);
        h.hsub.textContent = "rebooting";
        h.reboot.setAttribute("opacity", 1);
        h.reboot.style.transition = "none";
        h.reboot.style.strokeDashoffset = String(RC);
        void h.reboot.getBoundingClientRect();
        h.reboot.style.transition = "stroke-dashoffset 3800ms linear";
        h.reboot.style.strokeDashoffset = "0";
        if (i === holder) {
            const next = hosts.findIndex(x => !x.dead);
            if (next !== -1) st.after(900, () => setHolder(next));
        }
        st.after(3800, () => {
            h.dead = false;
            h.g.setAttribute("data-dead", "false");
            h.hsub.textContent = "";
            h.reboot.setAttribute("opacity", 0);
            h.p.state("standby");
            h.p.sub("standby");
            // The claim outlived the hosts; the first peer back takes it.
            if (hosts[holder].dead) setHolder(i);
        });
    }

    function scheduleIdleKill(delay = 9500) {
        if (idleKill) clearTimeout(idleKill);
        if (reduced) return;
        idleKill = setTimeout(() => {
            if (st.running) kill(holder);
            scheduleIdleKill();
        }, delay);
    }

    return {
        start() { st.start(); scheduleIdleKill(3200); },
        stop() {
            st.stop();
            if (idleKill) clearTimeout(idleKill);
            hosts.forEach(h => {
                h.dead = false;
                h.g.setAttribute("data-dead", "false");
                h.hsub.textContent = "";
                h.reboot.setAttribute("opacity", 0);
            });
            setHolder(holder);
        },
    };
});

// ---------- Many: N Solo slots, one shared cohort ----------

scene("many", svg => {
    const st = new Stage();
    const RR = 9, RC = 2 * Math.PI * RR;

    const chan = el("g");
    chan.appendChild(el("rect", { class: "chan", x: 160, y: 22, width: 200, height: 28, rx: 8 }));
    chan.appendChild(el("text", { class: "h-label", x: 260, y: 68 }, "images"));
    svg.appendChild(chan);

    const hosts = [];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const g = el("g", {
            class: "host-g", role: "button", tabindex: 0,
            "aria-label": `Kill host-${i + 1}`,
        });
        g.appendChild(el("rect", { class: "host", x, y: 88, width: 150, height: 170, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 110 }, `host-${i + 1}`));
        const hsub = el("text", { class: "h-sub", x: x + 75, y: 126 }, "");
        g.appendChild(hsub);
        const reboot = el("circle", {
            class: "backoff-ring", cx: x + 132, cy: 106, r: RR,
            "stroke-dasharray": RC, "stroke-dashoffset": 0, opacity: 0,
            transform: `rotate(-90 ${x + 132} 106)`,
        });
        g.appendChild(reboot);
        svg.appendChild(g);
        hosts.push({ g, hsub, reboot, x, dead: false });
        g.addEventListener("click", () => kill(i));
        g.addEventListener("keydown", ev => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); kill(i); }
        });
    }

    // Four slots, unevenly placed on purpose: capacity, not symmetry,
    // decides where claims land.
    const slots = [];
    for (let n = 1; n <= 4; n++) {
        const g = proc(0, 0, `pool-${n}`, { r: 12, state: "running" });
        g.classList.add("mover");
        g.classList.add("sm");
        g.appendChild(el("circle", { class: "claim-ring", r: 19 }));
        svg.appendChild(g);
        slots.push({ g, host: n === 1 || n === 2 ? 0 : n - 2 });
    }

    function layout() {
        for (const [i, h] of hosts.entries()) {
            const mine = slots.filter(s => s.host === i);
            mine.forEach((s, j) => {
                const cx = h.x + 75 + (j - (mine.length - 1) / 2) * 54;
                s.cx = cx;
                s.g.style.transform = `translate(${cx}px, 200px)`;
            });
        }
    }
    layout();

    const rails = new Set();
    const held = new Set();
    const q = [];

    function syncChan() {
        q.forEach((d, i) => {
            d.style.transform = `translate(${310 - i * 28}px, 36px)`;
            d.dataset.x = 310 - i * 28;
        });
    }

    function feed() {
        st.after(500 + Math.random() * 250, () => {
            if (q.length < 5) {
                const d = el("circle", { class: "signal msg parked", r: 4 });
                d.style.transform = "translate(175px, 36px)";
                d.dataset.x = 175;
                d.dataset.y = 36;
                svg.appendChild(d);
                q.push(d);
                syncChan();
            }
            feed();
        });
    }

    function work() {
        st.after(1800, () => {
            const live = slots.filter(s => !hosts[s.host].dead);
            // Shuffle so no slot starves when work is scarce.
            for (let i = live.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [live[i], live[j]] = [live[j], live[i]];
            }
            for (const s of live) {
                // Delivery is a claim: the dot dims in place and a
                // copy travels; ack removes it, nak un-dims.
                const orig = q.find(d => !d.dataset.claimed);
                if (!orig) break;
                orig.dataset.claimed = "1";
                orig.classList.add("claimed");
                const copy = el("circle", { class: "signal msg", r: 4 });
                copy.style.transform = orig.style.transform;
                svg.appendChild(copy);
                const release = () => {
                    delete orig.dataset.claimed;
                    orig.classList.remove("claimed");
                };
                const r = rail(+orig.dataset.x, +orig.dataset.y, s.cx, 200);
                rails.add(r);
                svg.appendChild(r);
                const hi = s.host, cx = s.cx;
                travel(st, svg, r, {
                    node: copy, dur: 600,
                    onArrive() {
                        if (hosts[s.host].dead || s.host !== hi || s.cx !== cx) {
                            // The slot died or re-claimed elsewhere
                            // mid-flight; the claim releases.
                            travel(st, svg, r, {
                                node: copy, dur: 600, reverse: true,
                                onArrive() {
                                    copy.remove();
                                    release();
                                    r.remove();
                                    rails.delete(r);
                                },
                            });
                            return;
                        }
                        held.add(copy);
                        st.after(1000, () => {
                            held.delete(copy);
                            copy.remove();
                            const idx = q.indexOf(orig);
                            if (idx !== -1) q.splice(idx, 1);
                            orig.remove();
                            syncChan();
                        });
                        r.remove();
                        rails.delete(r);
                    },
                });
            }
            syncChan();
            work();
        });
    }

    function fewest(exclude) {
        let best = -1, n = Infinity;
        for (const [i, h] of hosts.entries()) {
            if (h.dead || i === exclude) continue;
            const c = slots.filter(s => s.host === i).length;
            if (c < n) { n = c; best = i; }
        }
        return best;
    }

    function kill(i) {
        const h = hosts[i];
        if (h.dead || !st.running) return;
        if (hosts.filter(x => !x.dead).length < 2) return;
        scheduleIdle();
        h.dead = true;
        h.g.setAttribute("data-dead", "true");
        h.hsub.textContent = "rebooting";
        h.reboot.setAttribute("opacity", 1);
        h.reboot.style.transition = "none";
        h.reboot.style.strokeDashoffset = String(RC);
        void h.reboot.getBoundingClientRect();
        h.reboot.style.transition = "stroke-dashoffset 3800ms linear";
        h.reboot.style.strokeDashoffset = "0";
        // Displaced slots re-claim on the survivors.
        st.after(700, () => {
            for (const s of slots) {
                if (s.host === i) s.host = fewest(i);
            }
            layout();
        });
        st.after(3800, () => {
            h.dead = false;
            h.g.setAttribute("data-dead", "false");
            h.hsub.textContent = "";
            h.reboot.setAttribute("opacity", 0);
            // Placement rebalances toward the returned peer.
            st.after(1600, () => {
                if (h.dead || slots.some(s => s.host === i)) return;
                let fullest = -1, n = 0;
                for (const [j, hh] of hosts.entries()) {
                    if (hh.dead) continue;
                    const c = slots.filter(s => s.host === j).length;
                    if (c > n) { n = c; fullest = j; }
                }
                if (fullest !== -1 && n >= 2) {
                    slots.find(s => s.host === fullest).host = i;
                    layout();
                }
            });
        });
    }

    let idle = null;
    function scheduleIdle() {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running) {
                const alive = hosts.map((h, i) => ({ h, i })).filter(x => !x.h.dead);
                if (alive.length > 1) kill(alive[Math.floor(Math.random() * alive.length)].i);
            }
            scheduleIdle();
        }, 9500);
    }

    return {
        start() { st.start(); scheduleIdle(); if (!reduced) { feed(); work(); } },
        stop() {
            st.stop();
            if (idle) clearTimeout(idle);
            for (const r of rails) r.remove();
            rails.clear();
            for (const c of held) c.remove();
            held.clear();
            for (const d of q) d.remove();
            q.length = 0;
            hosts.forEach(h => {
                h.dead = false;
                h.g.setAttribute("data-dead", "false");
                h.hsub.textContent = "";
                h.reboot.setAttribute("opacity", 0);
            });
        },
    };
});

// ---------- Messages: at-least-once, FIFO, redelivery ----------

scene("send", svg => {
    const st = new Stage();
    const prod = proc(75, 130, "checkout", { r: 16, state: "running" });
    svg.appendChild(prod);
    const chan = el("g");
    chan.appendChild(el("rect", { class: "chan", x: 170, y: 106, width: 180, height: 48, rx: 8 }));
    chan.appendChild(el("text", { class: "h-label", x: 260, y: 175 }, "orders"));
    svg.appendChild(chan);
    const cons = proc(445, 130, "mailer", { r: 16, state: "running" });
    svg.appendChild(cons);
    const R = 26, C = 2 * Math.PI * R;
    const ring = el("circle", {
        class: "backoff-ring", cx: 445, cy: 130, r: R,
        "stroke-dasharray": C, "stroke-dashoffset": 0, opacity: 0,
        transform: "rotate(-90 445 130)",
    });
    svg.appendChild(ring);
    const pIn = rail(91, 130, 186, 130);
    const pOut = rail(334, 130, 445, 130);
    svg.appendChild(pIn);
    svg.appendChild(pOut);

    const btnSend = document.querySelector('#send .ctl[data-act="send"]');
    const btnCrash = document.querySelector('#send .ctl[data-act="crash"]');

    let seq = 0, queue = [], processing = null, down = false, inFlight = 0;

    function mkdot(num, x, y) {
        const g = el("g", { class: "qdot" });
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.appendChild(el("circle", { r: 9 }));
        g.appendChild(el("text", { y: 3.5 }, String(num)));
        svg.appendChild(g);
        return g;
    }

    // Conveyor: new messages park at the left; the head sits at the
    // right, where the delivery rail begins.
    function slots() {
        queue.forEach((q, i) => {
            q.node.style.transform = `translate(${324 - i * 30}px, 130px)`;
        });
    }

    function send() {
        if (!st.running || queue.length + inFlight >= 4) return;
        seq++;
        inFlight++;
        const num = seq;
        const d = mkdot(num, 91, 130);
        travel(st, svg, pIn, {
            node: d, dur: 500,
            onArrive() {
                inFlight--;
                d.classList.add("parked");
                queue.push({ node: d, num, at: performance.now() });
                slots();
                pump();
            },
        });
    }

    function pump() {
        if (!st.running || down || processing || !queue.length) return;
        // Let the head sit visibly in the channel before delivery.
        const dwell = 900 - (performance.now() - queue[0].at);
        if (dwell > 0) {
            st.after(dwell, pump);
            return;
        }
        // Delivery is a claim: the head dims in place and a copy
        // travels; ack removes it, nak un-dims.
        const head = queue[0];
        head.node.classList.add("claimed");
        const copy = mkdot(head.num, 0, 0);
        copy.style.transform = head.node.style.transform;
        processing = { head, copy };
        travel(st, svg, pOut, {
            node: copy, dur: 500,
            onArrive() {
                if (down) return; // crash landed first; nak handles it
                cons.sub(`msg ${head.num}`);
                st.after(1400, () => {
                    if (down || !processing || processing.head !== head) {
                        return;
                    }
                    copy.remove();
                    queue.shift();
                    head.node.remove();
                    slots();
                    cons.sub(`✓ ${head.num}`);
                    processing = null;
                    st.after(1000, () => { if (!down) cons.sub(""); });
                    pump();
                });
            },
        });
    }

    function crash() {
        if (!st.running || down) return;
        down = true;
        if (btnCrash) btnCrash.disabled = true;
        cons.state("crashed");

        if (processing) {
            const { head, copy } = processing;
            processing = null;
            // Nak: the copy returns and the head un-dims in place,
            // order preserved by construction.
            travel(st, svg, pOut, {
                node: copy, dur: 500, reverse: true,
                onArrive() {
                    copy.remove();
                    head.at = performance.now();
                    head.node.classList.remove("claimed");
                },
            });
        }
        st.after(1000, () => {
            cons.state("backoff");
            cons.sub("restarting");
            ring.setAttribute("opacity", 1);
            ring.style.transition = "none";
            ring.style.strokeDashoffset = "0";
            void ring.getBoundingClientRect();
            ring.style.transition = "stroke-dashoffset 1800ms linear";
            ring.style.strokeDashoffset = String(C);
        });
        st.after(2800, () => {
            ring.setAttribute("opacity", 0);
            cons.state("running");
            cons.sub("");
            down = false;
            if (btnCrash) btnCrash.disabled = false;
            pump();
        });
    }

    function ambientSend() {
        st.after(2400 + Math.random() * 800, () => {
            send();
            // Occasional burst, so the channel visibly holds a queue.
            if (Math.random() < 0.35) st.after(350, send);
            ambientSend();
        });
    }
    function ambientCrash() {
        st.after(11000 + Math.random() * 4000, () => {
            if (processing) crash();
            ambientCrash();
        });
    }

    return {
        start() {
            st.start();
            down = false;
            if (btnCrash) btnCrash.disabled = false;
            if (!reduced) { ambientSend(); ambientCrash(); }
        },
        stop() {
            st.stop();
            for (const q of queue) q.node.remove();
            if (processing) { processing.copy.remove(); processing = null; }
            queue = [];
            inFlight = 0;
            down = false;
            ring.setAttribute("opacity", 0);
            cons.state("running");
            cons.sub("");
        },
        acts: { send, crash },
    };
});

// ---------- Cron: durable ticks, at-least-once ----------

scene("load", svg => {
    const st = new Stage();
    const hosts = [];
    const R = 26, C = 2 * Math.PI * R;
    const TICK = 6000, WORK = 1600;

    const store = el("g");
    store.appendChild(el("rect", { class: "chan", x: 185, y: 225, width: 150, height: 44, rx: 8 }));
    const storeText = el("text", { class: "n-label", x: 260, y: 252 }, "last: tick 3");
    store.appendChild(storeText);
    store.appendChild(el("text", { class: "h-label", x: 260, y: 292 }, "cron/backup/last"));
    svg.appendChild(store);

    for (let i = 0; i < 2; i++) {
        const x = 40 + i * 260;
        const g = el("g", { class: "host-g" });
        g.appendChild(el("rect", { class: "host", x, y: 42, width: 180, height: 148, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 90, y: 64 }, `host-${i + 1}`));
        const hsub = el("text", { class: "h-sub", x: x + 90, y: 80 }, "");
        g.appendChild(hsub);
        const p = proc(x + 90, 118, "cron/backup", { r: 16, dy: 8, state: i === 0 ? "running" : "standby" });
        g.appendChild(p);
        const tick = el("circle", {
            class: "tick-ring", cx: x + 90, cy: 118, r: R,
            "stroke-dasharray": C, "stroke-dashoffset": C, opacity: 0,
            transform: `rotate(-90 ${x + 90} 118)`,
        });
        g.appendChild(tick);
        const write = rail(x + 90, 136, 260, 225);
        const load = rail(260, 225, x + 90, 136);
        svg.appendChild(write);
        svg.appendChild(load);
        svg.appendChild(g);
        hosts.push({ g, p, hsub, tick, write, load, dead: false });
    }

    let holder = 0, T = 3, working = false;
    const btn = document.querySelector('#load .ctl[data-act="kill"]');

    function countdown() {
        const h = hosts[holder];
        if (h.dead || !st.running) return;
        h.p.sub("next: tick " + (T + 1));
        h.tick.setAttribute("opacity", 1);
        h.tick.style.transition = "none";
        h.tick.style.strokeDashoffset = String(C);
        void h.tick.getBoundingClientRect();
        h.tick.style.transition = `stroke-dashoffset ${TICK}ms linear`;
        h.tick.style.strokeDashoffset = "0";
        st.after(TICK, work);
    }

    function work() {
        const h = hosts[holder];
        if (h.dead || !st.running) return;
        working = true;
        h.tick.setAttribute("opacity", 0);
        h.p.setAttribute("data-work", "true");
        h.p.sub("running backup");
        st.after(WORK, () => {
            if (h.dead) return;
            h.p.setAttribute("data-work", "false");
            travel(st, svg, h.write, {
                cls: "msg", dur: 500,
                onArrive() {
                    if (h.dead) return;
                    working = false;
                    T++;
                    storeText.textContent = "last: tick " + T;
                    countdown();
                },
            });
        });
    }

    function kill() {
        const h = hosts[holder];
        if (h.dead || !st.running) return;
        const wasWorking = working;
        working = false;
        h.dead = true;
        h.g.setAttribute("data-dead", "true");
        h.p.state("hidden");
        h.p.sub("");
        h.p.setAttribute("data-work", "false");
        h.tick.setAttribute("opacity", 0);
        h.hsub.textContent = "rebooting";
        if (btn) btn.disabled = true;
        const next = holder === 0 ? 1 : 0;
        st.after(1000, () => {
            holder = next;
            const nh = hosts[next];
            nh.p.state("running");
            // Load: the new holder reads the durable last-run.
            travel(st, svg, nh.load, {
                cls: "msg", dur: 600,
                onArrive() {
                    nh.p.sub("Load → tick " + T);
                    if (wasWorking) {
                        // The missed tick never recorded; run it again.
                        st.after(1000, work);
                    } else {
                        st.after(1000, countdown);
                    }
                },
            });
        });
        st.after(4500, () => {
            h.dead = false;
            h.g.setAttribute("data-dead", "false");
            h.hsub.textContent = "";
            h.p.state("standby");
            if (btn) btn.disabled = false;
        });
    }

    function ambient() {
        st.after(12000 + Math.random() * 5000, () => {
            // Strike during the next work window, not only if the
            // timer happens to land inside one.
            const strike = () => {
                if (!st.running) return;
                if (working) {
                    kill();
                    ambient();
                    return;
                }
                st.after(400, strike);
            };
            strike();
        });
    }

    return {
        start() {
            st.start();
            if (btn) btn.disabled = false;
            if (!reduced) { countdown(); ambient(); }
        },
        stop() {
            st.stop();
            working = false;
            hosts.forEach((h, j) => {
                h.dead = false;
                h.g.setAttribute("data-dead", "false");
                h.hsub.textContent = "";
                h.tick.setAttribute("opacity", 0);
                h.p.setAttribute("data-work", "false");
                h.p.state(j === holder ? "running" : "standby");
                h.p.sub("");
            });
        },
        acts: { kill },
    };
});

// ---------- Chan: one proc, two typed inboxes ----------

scene("chan", svg => {
    const st = new Stage();

    function channel(y, label) {
        const g = el("g");
        g.appendChild(el("rect", { class: "chan", x: 60, y, width: 175, height: 44, rx: 8 }));
        g.appendChild(el("text", { class: "h-label", x: 147, y: y + 64 }, label));
        svg.appendChild(g);
    }
    channel(70, "orders");
    channel(170, "cancels");
    const inbox = proc(430, 145, "inbox", { r: 16, state: "running" });
    svg.appendChild(inbox);
    const R = 26, C = 2 * Math.PI * R;
    const ring = el("circle", {
        class: "backoff-ring", cx: 430, cy: 145, r: R,
        "stroke-dasharray": C, "stroke-dashoffset": 0, opacity: 0,
        transform: "rotate(-90 430 145)",
    });
    svg.appendChild(ring);
    const rails = [rail(205, 92, 430, 145), rail(205, 192, 430, 145)];
    for (const r of rails) svg.appendChild(r);

    const btns = {
        order: document.querySelector('#chan .ctl[data-act="order"]'),
        cancel: document.querySelector('#chan .ctl[data-act="cancel"]'),
        crash: document.querySelector('#chan .ctl[data-act="crash"]'),
    };

    // Two queues; cancels ride square dots.
    const chans = [
        { q: [], seq: 0, y: 92, square: false },
        { q: [], seq: 0, y: 192, square: true },
    ];
    let holding = null, down = false;

    function mkdot(num, square, y) {
        const g = el("g", { class: "qdot" });
        g.style.transform = `translate(68px, ${y}px)`;
        if (square) {
            g.appendChild(el("rect", { x: -8, y: -8, width: 16, height: 16, rx: 3 }));
        } else {
            g.appendChild(el("circle", { r: 9 }));
        }
        g.appendChild(el("text", { y: 3.5 }, String(num)));
        svg.appendChild(g);
        return g;
    }

    function slots(c) {
        c.q.forEach((m, i) => {
            m.node.style.transform = `translate(${200 - i * 30}px, ${c.y}px)`;
        });
    }

    function send(ci) {
        const c = chans[ci];
        if (!st.running || c.q.length >= 4) return;
        c.seq++;
        const d = mkdot(c.seq, c.square, c.y);
        c.q.push({ node: d, num: c.seq, at: performance.now(), ci });
        d.classList.add("parked");
        slots(c);
        pump();
    }

    let flip = 0;
    function pump() {
        if (!st.running || down || holding) return;
        // select: take from whichever inbox has mail, alternating
        // when both do.
        const order = [chans[flip], chans[1 - flip]];
        const c = order.find(x => x.q.length);
        if (!c) return;
        flip = 1 - chans.indexOf(c);
        const dwell = 800 - (performance.now() - c.q[0].at);
        if (dwell > 0) {
            st.after(dwell, pump);
            return;
        }
        // Delivery is a claim: the head dims in place and a copy
        // travels; ack removes it, nak un-dims.
        const m = c.q[0];
        m.node.classList.add("claimed");
        const copy = mkdot(m.num, m.ci, 0);
        copy.style.transform = m.node.style.transform;
        holding = { m, copy };
        travel(st, svg, rails[m.ci], {
            node: copy, dur: 500,
            onArrive() {
                if (down) return;
                inbox.sub((m.ci ? "cancel " : "order ") + m.num);
                st.after(1100, () => {
                    if (down || !holding || holding.m !== m) return;
                    copy.remove();
                    c.q.shift();
                    m.node.remove();
                    slots(c);
                    inbox.sub("✓ " + (m.ci ? "cancel " : "order ") + m.num);
                    holding = null;
                    st.after(1000, () => { if (!down) inbox.sub(""); });
                    pump();
                });
            },
        });
    }

    function crash() {
        if (!st.running || down) return;
        down = true;
        if (btns.crash) btns.crash.disabled = true;
        inbox.state("crashed");

        if (holding) {
            const { m, copy } = holding;
            holding = null;
            travel(st, svg, rails[m.ci], {
                node: copy, dur: 500, reverse: true,
                onArrive() {
                    copy.remove();
                    m.at = performance.now();
                    m.node.classList.remove("claimed");
                },
            });
        }
        st.after(1000, () => {
            inbox.state("backoff");
            inbox.sub("restarting");
            ring.setAttribute("opacity", 1);
            ring.style.transition = "none";
            ring.style.strokeDashoffset = "0";
            void ring.getBoundingClientRect();
            ring.style.transition = "stroke-dashoffset 1800ms linear";
            ring.style.strokeDashoffset = String(C);
        });
        st.after(2800, () => {
            ring.setAttribute("opacity", 0);
            inbox.state("running");
            inbox.sub("");
            down = false;
            if (btns.crash) btns.crash.disabled = false;
            pump();
        });
    }

    function ambient() {
        st.after(2300 + Math.random() * 900, () => {
            send(Math.random() < 0.6 ? 0 : 1);
            ambient();
        });
    }
    function ambientCrash() {
        st.after(12000 + Math.random() * 4000, () => {
            if (holding) crash();
            ambientCrash();
        });
    }

    return {
        start() {
            st.start();
            down = false;
            if (btns.crash) btns.crash.disabled = false;
            if (!reduced) { send(0); ambient(); ambientCrash(); }
        },
        stop() {
            st.stop();
            for (const c of chans) {
                for (const m of c.q) m.node.remove();
                c.q.length = 0;
            }
            if (holding) { holding.copy.remove(); holding = null; }
            down = false;
            ring.setAttribute("opacity", 0);
            inbox.state("running");
            inbox.sub("");
        },
        acts: { order: () => send(0), cancel: () => send(1), crash },
    };
});

// ---------- Query/Serve: request and reply are messages ----------

scene("query", svg => {
    const st = new Stage();
    const api = proc(75, 130, "api", { r: 16, state: "running" });
    svg.appendChild(api);
    const chan = el("g");
    chan.appendChild(el("rect", { class: "chan", x: 170, y: 106, width: 180, height: 48, rx: 8 }));
    chan.appendChild(el("text", { class: "h-label", x: 260, y: 175 }, "double"));
    svg.appendChild(chan);
    const srv = proc(445, 130, "double", { r: 16, state: "running" });
    svg.appendChild(srv);
    const R = 26, C = 2 * Math.PI * R;
    const ring = el("circle", {
        class: "backoff-ring", cx: 445, cy: 130, r: R,
        "stroke-dasharray": C, "stroke-dashoffset": 0, opacity: 0,
        transform: "rotate(-90 445 130)",
    });
    svg.appendChild(ring);
    const pAsk = rail(91, 130, 186, 130);
    const pServe = rail(334, 130, 445, 130);
    // The reply skips the channel: it lands in the requester's own
    // one-shot inbox.
    const pReply = el("path", {
        d: "M 445 130 C 445 240, 75 240, 75 130",
        fill: "none",
    });
    for (const p of [pAsk, pServe, pReply]) svg.appendChild(p);

    const btnAsk = document.querySelector('#query .ctl[data-act="ask"]');
    const btnCrash = document.querySelector('#query .ctl[data-act="crash"]');

    let queue = [], working = null, down = false, seq = 0;
    let asking = 0;

    function mkdot(text, x, y, reply) {
        const g = el("g", { class: "qdot payload" + (reply ? " reply" : "") });
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.appendChild(el("circle", { r: 10 }));
        g.appendChild(el("text", { y: 3.5 }, text));
        svg.appendChild(g);
        return g;
    }

    function slots() {
        queue.forEach((q, i) => {
            q.node.style.transform = `translate(${324 - i * 32}px, 130px)`;
        });
    }

    function ask() {
        // Two queueable plus one slot held back for a crash-nak.
        if (!st.running || queue.length + asking >= 2) return;
        asking++;
        seq++;
        const n = 2 + ((seq * 7) % 40);
        const d = mkdot(String(n), 75, 130);
        travel(st, svg, pAsk, {
            node: d, dur: 450,
            onArrive() {
                asking--;
                d.classList.add("parked");
                queue.push({ node: d, n, at: performance.now() });
                slots();
                serve();
            },
        });
    }

    function serve() {
        if (!st.running || down || working || !queue.length) return;
        const dwell = 800 - (performance.now() - queue[0].at);
        if (dwell > 0) {
            st.after(dwell, serve);
            return;
        }
        // Delivery is a claim: the head dims in place and a copy
        // travels; ack removes it, nak un-dims.
        const q = queue[0];
        q.node.classList.add("claimed");
        const copy = mkdot(String(q.n), 0, 0);
        copy.style.transform = q.node.style.transform;
        working = { q, copy };
        travel(st, svg, pServe, {
            node: copy, dur: 450,
            onArrive() {
                if (down) return;
                srv.sub(`${q.n} × 2`);
                st.after(1200, () => {
                    if (down || !working || working.q !== q) return;
                    copy.remove();
                    queue.shift();
                    q.node.remove();
                    slots();
                    srv.sub("");
                    working = null;
                    const r = mkdot(String(q.n * 2), 445, 130, true);
                    travel(st, svg, pReply, {
                        node: r, dur: 800,
                        onArrive() {
                            r.remove();
                            api.sub(`✓ ${q.n * 2}`);
                            st.after(1000, () => api.sub(""));
                            serve();
                        },
                    });
                });
            },
        });
    }

    function crash() {
        if (!st.running || down) return;
        down = true;
        if (btnCrash) btnCrash.disabled = true;
        srv.state("crashed");

        if (working) {
            const { q, copy } = working;
            working = null;
            travel(st, svg, pServe, {
                node: copy, dur: 450, reverse: true,
                onArrive() {
                    copy.remove();
                    q.at = performance.now();
                    q.node.classList.remove("claimed");
                },
            });
        }
        st.after(1000, () => {
            srv.state("backoff");
            srv.sub("restarting");
            ring.setAttribute("opacity", 1);
            ring.style.transition = "none";
            ring.style.strokeDashoffset = "0";
            void ring.getBoundingClientRect();
            ring.style.transition = "stroke-dashoffset 1800ms linear";
            ring.style.strokeDashoffset = String(C);
        });
        st.after(2800, () => {
            ring.setAttribute("opacity", 0);
            srv.state("running");
            srv.sub("");
            down = false;
            if (btnCrash) btnCrash.disabled = false;
            serve();
        });
    }

    function ambientAsk() {
        st.after(3000 + Math.random() * 1200, () => { ask(); ambientAsk(); });
    }
    function ambientCrash() {
        st.after(13000 + Math.random() * 5000, () => {
            if (working) crash();
            ambientCrash();
        });
    }

    return {
        start() {
            st.start();
            down = false;
            if (btnCrash) btnCrash.disabled = false;
            if (!reduced) { ask(); ambientAsk(); ambientCrash(); }
        },
        stop() {
            asking = 0;
            st.stop();
            for (const q of queue) q.node.remove();
            queue = [];
            if (working) { working.copy.remove(); working = null; }
            down = false;
            ring.setAttribute("opacity", 0);
            srv.state("running");
            srv.sub("");
            api.sub("");
        },
        acts: { ask, crash },
    };
});

// ---------- Pipeline: durable execution as messages ----------

scene("go", svg => {
    const st = new Stage();

    function channel(x, label) {
        const g = el("g");
        g.appendChild(el("rect", { class: "chan", x, y: 98, width: 110, height: 44, rx: 8 }));
        g.appendChild(el("text", { class: "h-label", x: x + 55, y: 162 }, label));
        svg.appendChild(g);
    }
    const checkout = proc(45, 120, "step1", { r: 12, state: "running" });
    channel(85, "orders");
    const billing = proc(255, 120, "step2", { r: 16, state: "running" });
    channel(305, "invoices");
    const mailer = proc(475, 120, "step3", { r: 16, state: "running" });
    svg.appendChild(checkout);
    svg.appendChild(billing);
    svg.appendChild(mailer);
    const R = 26, C = 2 * Math.PI * R;
    const ring = el("circle", {
        class: "backoff-ring", cx: 255, cy: 120, r: R,
        "stroke-dasharray": C, "stroke-dashoffset": 0, opacity: 0,
        transform: "rotate(-90 255 120)",
    });
    svg.appendChild(ring);

    const pSend = rail(57, 120, 100, 120);
    const pBill = rail(172, 120, 255, 120);
    const pEmit = rail(255, 120, 320, 120);
    const pMail = rail(392, 120, 475, 120);
    for (const p of [pSend, pBill, pEmit, pMail]) svg.appendChild(p);

    // Conveyor FIFO: dots enter each channel at the left and leave
    // from the right, oldest first.
    let seq = 0, down = false, working = null;
    const orders = [], invoices = [];
    const btn = document.querySelector('#go .ctl[data-act="crash"]');

    function slots(q, x0) {
        q.forEach((m, i) => {
            m.node.style.transform = `translate(${x0 - i * 28}px, 120px)`;
        });
    }
    const syncOrders = () => slots(orders, 165);
    const syncInvoices = () => slots(invoices, 385);

    function mkdot(num, x, y) {
        const g = el("g", { class: "qdot" });
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.appendChild(el("circle", { r: 9 }));
        g.appendChild(el("text", { y: 3.5 }, String(num)));
        svg.appendChild(g);
        return g;
    }

    function send() {
        if (!st.running || orders.length >= 2) return;
        seq++;
        const d = mkdot(seq, 45, 120);
        travel(st, svg, pSend, {
            node: d, dur: 450,
            onArrive() {
                d.classList.add("parked");
                orders.push({ node: d, num: seq, at: performance.now() });
                syncOrders();
                bill();
            },
        });
    }

    function bill() {
        if (!st.running || down || working || !orders.length) return;
        const dwell = 700 - (performance.now() - orders[0].at);
        if (dwell > 0) {
            st.after(dwell, bill);
            return;
        }
        // Delivery is a claim: the head dims in place and a copy
        // travels; the ack coincides with sending the invoice.
        const m = orders[0];
        m.node.classList.add("claimed");
        const copy = mkdot(m.num, 0, 0);
        copy.style.transform = m.node.style.transform;
        working = { m, copy };
        travel(st, svg, pBill, {
            node: copy, dur: 450,
            onArrive() {
                if (down) return; // the crash already nak'd it
                billing.sub(`order ${m.num}`);
                st.after(1100, () => {
                    if (down || !working || working.m !== m) return;
                    billing.sub("");
                    working = null;
                    orders.shift();
                    m.node.remove();
                    syncOrders();
                    travel(st, svg, pEmit, {
                        node: copy, dur: 450,
                        onArrive() {
                            copy.classList.add("parked");
                            invoices.push({
                                node: copy,
                                num: m.num,
                                at: performance.now(),
                            });
                            syncInvoices();
                            mail();
                            bill();
                        },
                    });
                });
            },
        });
    }

    let mailing = false;
    function mail() {
        if (!st.running || mailing || !invoices.length) return;
        const dwell = 700 - (performance.now() - invoices[0].at);
        if (dwell > 0) {
            st.after(dwell, mail);
            return;
        }
        const m = invoices[0];
        m.node.classList.add("claimed");
        const copy = mkdot(m.num, 0, 0);
        copy.style.transform = m.node.style.transform;
        mailing = true;
        travel(st, svg, pMail, {
            node: copy, dur: 450,
            onArrive() {
                mailer.sub(`✓ ${m.num}`);
                st.after(1000, () => {
                    copy.remove();
                    invoices.shift();
                    m.node.remove();
                    syncInvoices();
                    mailer.sub("");
                    mailing = false;
                    mail();
                });
            },
        });
    }

    function crash() {
        if (!st.running || down) return;
        down = true;
        if (btn) btn.disabled = true;
        billing.state("crashed");

        if (working) {
            const { m, copy } = working;
            working = null;
            travel(st, svg, pBill, {
                node: copy, dur: 450, reverse: true,
                onArrive() {
                    copy.remove();
                    m.at = performance.now();
                    m.node.classList.remove("claimed");
                },
            });
        }
        st.after(1000, () => {
            billing.state("backoff");
            billing.sub("restarting");
            ring.setAttribute("opacity", 1);
            ring.style.transition = "none";
            ring.style.strokeDashoffset = "0";
            void ring.getBoundingClientRect();
            ring.style.transition = "stroke-dashoffset 1800ms linear";
            ring.style.strokeDashoffset = String(C);
        });
        st.after(2800, () => {
            ring.setAttribute("opacity", 0);
            billing.state("running");
            billing.sub("");
            down = false;
            if (btn) btn.disabled = false;
            bill();
        });
    }

    function ambientSend() {
        st.after(2800 + Math.random() * 900, () => { send(); ambientSend(); });
    }
    function ambientCrash() {
        st.after(12000 + Math.random() * 5000, () => {
            if (working) crash();
            ambientCrash();
        });
    }

    return {
        start() {
            st.start();
            down = false;
            if (btn) btn.disabled = false;
            if (!reduced) { send(); ambientSend(); ambientCrash(); }
        },
        stop() {
            st.stop();
            for (const q of [orders, invoices]) {
                for (const m of q) m.node.remove();
                q.length = 0;
            }
            if (working) { working.copy.remove(); working = null; }
            mailing = false;
            down = false;
            ring.setAttribute("opacity", 0);
            billing.state("running");
            billing.sub("");
            mailer.sub("");
        },
        acts: { crash },
    };
});

// ---------- Save: compare-and-swap on a durable cell ----------

scene("save", svg => {
    const st = new Stage();

    // The channel's dual nature: a message log on the left, the
    // last-written value on the right of the divider.
    const cell = el("g");
    cell.appendChild(el("rect", { class: "chan", x: 150, y: 115, width: 220, height: 44, rx: 8 }));
    cell.appendChild(el("line", {
        x1: 326, y1: 115, x2: 326, y2: 159,
        stroke: "var(--border)", "stroke-width": 1.5,
    }));
    const val = el("text", { class: "n-label", x: 348, y: 142 }, "7");
    cell.appendChild(val);
    cell.appendChild(el("text", { class: "h-label", x: 260, y: 182 }, "counter"));
    svg.appendChild(cell);

    const log = [];
    // Each peer's high-water mark: peer-1 points down from above
    // the log, peer-2 up from below, so a shared dot never overlaps.
    const marks = [
        el("polygon", {
            points: "0,-9 -5,-16 5,-16",
            fill: "var(--accent-text)", opacity: 0,
        }),
        el("polygon", {
            points: "0,9 -5,16 5,16",
            fill: "var(--accent-text)", opacity: 0,
        }),
    ];
    const hwm = [null, null];
    function slotX(i) {
        return 306 - (log.length - 1 - i) * 26;
    }
    function syncLog() {
        log.forEach((d, i) => {
            d.style.transform = `translate(${slotX(i)}px, 137px)`;
        });
        marks.forEach((m, p) => {
            const i = log.indexOf(hwm[p]);
            if (i === -1) {
                m.setAttribute("opacity", 0);
                return;
            }
            m.setAttribute("opacity", 1);
            m.style.transform = `translate(${slotX(i)}px, 137px)`;
        });
    }
    function mark(p, dot) {
        hwm[p] = dot;
        syncLog();
    }
    function appendLog(v) {
        const g = el("g", { class: "qdot payload parked" });
        g.appendChild(el("circle", { r: 8 }));
        g.appendChild(el("text", { y: 3.5 }, String(v)));
        svg.appendChild(g);
        log.push(g);
        if (log.length > 5) log.shift().remove();
        syncLog();
        return g;
    }
    for (const v of [5, 6, 7]) appendLog(v);
    for (const m of marks) svg.appendChild(m);

    const peers = [
        { p: proc(75, 137, "peer-1", { r: 16, state: "running" }), x: 75 },
        { p: proc(445, 137, "peer-2", { r: 16, state: "running" }), x: 445 },
    ];
    for (const pe of peers) svg.appendChild(pe.p);
    const rails = [
        rail(150, 137, 91, 137),
        rail(370, 137, 429, 137),
    ];
    for (const r of rails) svg.appendChild(r);

    let n = 7, racing = false;
    const btn = document.querySelector('#save .ctl[data-act="race"]');

    function load(i, done) {
        travel(st, svg, rails[i], {
            cls: "ack", r: 5, dur: 450,
            onArrive() {
                peers[i].p.sub(`n = ${n}`);
                mark(i, log[log.length - 1]);
                if (done) done();
            },
        });
    }

    function save(i, want, dur, done) {
        travel(st, svg, rails[i], {
            cls: "msg", r: 5, dur, reverse: true,
            onArrive() {
                if (want === n) {
                    n++;
                    val.textContent = String(n);
                    mark(i, appendLog(n));
                    peers[i].p.sub("committed");
                    if (done) done(true);
                } else {
                    peers[i].p.sub("conflict");
                    travel(st, svg, rails[i], {
                        cls: "conflict", r: 5, dur: 450,
                    });
                    if (done) done(false);
                }
            },
        });
    }

    function race() {
        if (!st.running || racing) return;
        racing = true;
        if (btn) btn.disabled = true;
        scheduleIdle();
        const fast = Math.round(Math.random());
        const slow = 1 - fast;
        // Both writers read the same head...
        load(fast);
        load(slow, () => {
            const want = n;
            st.after(500, () => {
                // ...and race their saves. One CAS lands.
                save(fast, want, 450);
                save(slow, want, 800, committed => {
                    if (committed) return;
                    // The loser re-reads and retries.
                    st.after(900, () => load(slow, () => {
                        const again = n;
                        st.after(500, () => save(slow, again, 450, () => {
                            st.after(1400, () => {
                                for (const pe of peers) pe.p.sub("");
                                racing = false;
                                if (btn) btn.disabled = false;
                            });
                        }));
                    }));
                });
            });
        });
    }

    let idle = null;
    function scheduleIdle(delay = 8500) {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running && !racing) race();
            scheduleIdle();
        }, delay);
    }

    return {
        start() {
            st.start();
            racing = false;
            if (btn) btn.disabled = false;
            scheduleIdle(2400);
        },
        stop() {
            st.stop();
            if (idle) clearTimeout(idle);
            racing = false;
            for (const pe of peers) pe.p.sub("");
            for (const d of log) d.remove();
            log.length = 0;
            hwm[0] = hwm[1] = null;
            n = 7;
            val.textContent = "7";
            for (const v of [5, 6, 7]) appendLog(v);
        },
        acts: { race },
    };
});

// ---------- Local: one process on a laptop, or a cluster ----------

scene("broker", svg => {
    const st = new Stage();

    const laptop = el("g");
    laptop.appendChild(el("rect", { class: "host", x: 130, y: 24, width: 260, height: 88, rx: 10 }));
    laptop.appendChild(el("text", { class: "h-label", x: 260, y: 42 }, "laptop — go run ."));
    svg.appendChild(laptop);

    const broker = el("text", { class: "n-sub", x: 260, y: 140 }, "new(mem.Broker)");
    svg.appendChild(broker);

    const hostEls = [];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const g = el("g", { class: "host-g" });
        g.appendChild(el("rect", { class: "host", x, y: 170, width: 150, height: 110, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 191 }, `host-${i + 1}`));
        svg.appendChild(g);
        hostEls.push(g);
    }

    // Every proc knows its laptop position and its cluster position.
    function mover(label, lx, ly, cx, cy, opts = {}) {
        const p = proc(0, 0, label, { r: 11, ...opts });
        p.classList.add("mover");
        p.classList.add("sm");
        p.style.transform = `translate(${lx}px, ${ly}px)`;
        svg.appendChild(p);
        return { p, lx, ly, cx, cy, extra: false, cluster: opts.cluster };
    }
    const movers = [
        mover("http", 160, 72, 65, 226, { state: "running" }),
        mover("mail", 225, 72, 125, 226, { state: "running" }),
        mover("pool-1", 290, 72, 265, 226, { state: "running" }),
        mover("pool-2", 355, 72, 435, 226, { state: "running" }),
    ];
    // These exist only on the cluster: Each expands to every peer,
    // and the other peers hold open mail slots, ready to claim.
    const extras = [
        mover("http", 260, 72, 215, 226, { state: "hidden" }),
        mover("http", 260, 72, 385, 226, { state: "hidden" }),
        mover("mail", 260, 72, 315, 226, { state: "hidden", cluster: "standby" }),
        mover("mail", 260, 72, 485, 226, { state: "hidden", cluster: "standby" }),
    ];
    extras.forEach(e => { e.extra = true; });

    // The claim ring rides inside the mail proc so it moves with it.
    movers[1].p.appendChild(el("circle", { class: "claim-ring", r: 17 }));

    let mode = "laptop";
    const btn = document.querySelector('#broker .ctl[data-act="toggle"]');

    function apply() {
        const cluster = mode === "cluster";
        for (const m of [...movers, ...extras]) {
            const x = cluster ? m.cx : m.lx;
            const y = cluster ? m.cy : m.ly;
            m.p.style.transform = `translate(${x}px, ${y}px)`;
            if (m.extra) {
                m.p.state(cluster ? (m.cluster || "running") : "hidden");
            }
        }
        broker.textContent = cluster
            ? "&procpgx.Broker{Pool: pool}" : "new(mem.Broker)";
        laptop.setAttribute("opacity", cluster ? 0.35 : 1);
        hostEls.forEach(h => h.setAttribute("opacity", cluster ? 1 : 0.35));
        if (btn) {
            btn.textContent = cluster
                ? "Run it locally" : "Deploy to the cluster";
        }
    }

    let idle = null;
    function scheduleIdle(delay = 6500) {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running) {
                mode = mode === "laptop" ? "cluster" : "laptop";
                apply();
            }
            scheduleIdle();
        }, delay);
    }

    function toggle() {
        if (!st.running) return;
        mode = mode === "laptop" ? "cluster" : "laptop";
        apply();
        scheduleIdle();
    }

    apply();

    return {
        start() { st.start(); scheduleIdle(2600); },
        stop() { st.stop(); if (idle) clearTimeout(idle); },
        acts: { toggle },
    };
});

// ---------- Deploy: the epoch tripwire ----------

scene("tripwire", svg => {
    const st = new Stage();
    const status = el("text", { class: "h-label", x: 260, y: 24 }, "");
    svg.appendChild(status);

    let epoch = 1042;
    const hosts = [];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const g = el("g", { class: "host-g" });
        g.appendChild(el("rect", { class: "host", x, y: 44, width: 150, height: 190, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 66 }, `host-${i + 1}`));
        const badge = el("text", { class: "h-sub", x: x + 75, y: 82 }, `epoch ${epoch}`);
        g.appendChild(badge);
        svg.appendChild(g);
        hosts.push({ g, badge, x, dead: false, epoch });
    }

    // The two singletons, drawn only where they are held.
    function solo(label) {
        const p = proc(0, 0, label, { r: 13, state: "running" });
        p.classList.add("mover");
        p.classList.add("sm");
        p.appendChild(el("circle", { class: "claim-ring", r: 20 }));
        p.style.transform = "translate(0px, 0px)";
        svg.appendChild(p);
        return p;
    }
    const solos = [
        { p: solo("mailer"), host: 0 },
        { p: solo("cron"), host: 1 },
        { p: solo("sweeper"), host: 2 },
    ];

    function layout() {
        for (const [i, h] of hosts.entries()) {
            const mine = solos.filter(s => s.host === i);
            mine.forEach((s, j) => {
                const cx = h.x + 75 + (j - (mine.length - 1) / 2) * 52;
                s.p.style.transform = `translate(${cx}px, 160px)`;
            });
        }
    }
    layout();

    function newCount() {
        return hosts.filter(h => h.epoch > epoch).length;
    }

    function sync() {
        const n = newCount();
        status.textContent = n === 0
            ? `epoch ${epoch} · all peers`
            : `epoch ${epoch + 1} on ${n} of 3 peers`;
    }
    sync();

    function moveOff(i) {
        for (const s of solos) {
            if (s.host !== i) continue;
            // Prefer a live new-epoch peer, else any live peer.
            const pick = hosts.findIndex(
                (h, j) => !h.dead && j !== i && h.epoch > epoch);
            const any = hosts.findIndex((h, j) => !h.dead && j !== i);
            s.host = pick !== -1 ? pick : any;
        }
        layout();
    }

    let rolling = false;
    const btn = document.querySelector('#tripwire .ctl[data-act="roll"]');

    function deployHost(i, done) {
        const h = hosts[i];
        h.dead = true;
        h.g.setAttribute("data-dead", "true");
        h.badge.textContent = "restarting";
        moveOff(i);
        st.after(1200, () => {
            h.dead = false;
            h.g.setAttribute("data-dead", "false");
            h.epoch = epoch + 1;
            h.badge.textContent = `epoch ${h.epoch}`;
            h.g.setAttribute("data-epoch", "new");
            sync();
            if (newCount() === 2) {
                // Majority: the tripwire fires and the singletons
                // move onto the new build.
                st.after(700, () => {
                    const fresh = hosts
                        .map((x, j) => ({ x, j }))
                        .filter(o => o.x.epoch > epoch);
                    solos.forEach((s, k) => {
                        s.host = fresh[k % fresh.length].j;
                    });
                    layout();
                });
            }
            st.after(1400, done);
        });
    }

    function roll() {
        if (!st.running || rolling) return;
        rolling = true;
        if (btn) btn.disabled = true;
        deployHost(0, () => deployHost(1, () => deployHost(2, () => {
            status.textContent = `epoch ${epoch + 1} · deploy complete`;
            epoch++;
            hosts.forEach(h => h.g.setAttribute("data-epoch", "old"));
            // With every peer on the same epoch, placement settles the
            // singletons back to an even spread.
            st.after(1200, () => {
                solos.forEach((s, k) => { s.host = k; });
                layout();
            });
            st.after(2600, () => {
                sync();
                rolling = false;
                if (btn) btn.disabled = false;
            });
        })));
    }

    let idle = null;
    function scheduleIdle(delay = 12000) {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running && !rolling) roll();
            scheduleIdle();
        }, delay);
    }

    return {
        start() {
            st.start();
            rolling = false;
            if (btn) btn.disabled = false;
            scheduleIdle(2800);
        },
        stop() {
            st.stop();
            if (idle) clearTimeout(idle);
            rolling = false;
            hosts.forEach(h => {
                h.dead = false;
                h.g.setAttribute("data-dead", "false");
                h.epoch = epoch;
                h.badge.textContent = `epoch ${epoch}`;
                h.g.setAttribute("data-epoch", "old");
            });
            layout();
            sync();
        },
        acts: { roll },
    };
});

// ---------- Fence: partition, self-fence, then handover ----------

scene("fence", svg => {
    const st = new Stage();

    const broker = el("g");
    broker.appendChild(el("rect", { class: "chan", x: 185, y: 238, width: 150, height: 34, rx: 8 }));
    broker.appendChild(el("text", { class: "h-label", x: 260, y: 259 }, "broker"));
    svg.appendChild(broker);

    const hosts = [];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const link = rail(x + 75, 196, 200 + i * 60, 238);
        link.setAttribute("class", "hb-link");
        svg.appendChild(link);
        const cut = el("text", {
            class: "errmark", x: (x + 75 + 200 + i * 60) / 2, y: 224, opacity: 0,
        }, "✕");
        svg.appendChild(cut);
        const g = el("g", {
            class: "host-g", role: "button", tabindex: 0,
            "aria-label": `Disconnect host-${i + 1}`,
        });
        g.appendChild(el("rect", { class: "host", x, y: 46, width: 150, height: 150, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 68 }, `host-${i + 1}`));
        const hsub = el("text", { class: "h-sub", x: x + 75, y: 84 }, "");
        g.appendChild(hsub);
        const p = proc(x + 75, 130, "worker", { r: 14, state: i === 0 ? "running" : "standby" });
        p.sub(i === 0 ? "holds claim" : "standby");
        g.appendChild(p);
        const ring = el("circle", {
            class: "claim-ring", cx: x + 75, cy: 130, r: 22,
            opacity: i === 0 ? 1 : 0,
        });
        g.appendChild(ring);
        svg.appendChild(g);
        hosts.push({ g, p, ring, hsub, link, cut, connected: true, inflight: 0 });
        g.addEventListener("click", () => disconnect(i));
        g.addEventListener("keydown", ev => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); disconnect(i); }
        });
    }

    let holder = 0;

    function heartbeats() {
        st.after(1300, () => {
            for (const h of hosts) {
                if (h.connected) {
                    h.inflight++;
                    travel(st, svg, h.link, {
                        cls: "msg", r: 3, dur: 550,
                        onArrive() {
                            if (!h.connected) { h.inflight--; return; }
                            travel(st, svg, h.link, {
                                cls: "ack", r: 3, dur: 550, reverse: true,
                                onArrive() { h.inflight--; },
                            });
                        },
                    });
                }
            }
            heartbeats();
        });
    }

    function setHolder(i) {
        holder = i;
        hosts.forEach((h, j) => {
            h.ring.setAttribute("opacity", j === i && h.connected ? 1 : 0);
            if (h.connected) {
                h.p.state(j === i ? "running" : "standby");
                h.p.sub(j === i ? "holds claim" : "standby");
            }
        });
    }

    let busy = false;
    function disconnect(i) {
        const h = hosts[i];
        if (!h.connected || busy || !st.running) return;
        busy = true;
        scheduleIdle();
        h.connected = false;
        // The line breaks between messages, never under one.
        const cutWhenClear = () => {
            if (h.inflight > 0) {
                st.after(120, cutWhenClear);
                return;
            }
            h.link.setAttribute("data-cut", "true");
            h.cut.setAttribute("opacity", 1);
        };
        cutWhenClear();
        h.hsub.textContent = "no heartbeat";
        // Past the threshold, the peer fences itself...
        st.after(2300, () => {
            h.p.state("canceled");
            h.p.sub("");
            h.ring.setAttribute("opacity", 0);
            h.hsub.textContent = "fenced";
        });
        // ...and only after the lease lapses does the claim move.
        if (i === holder) {
            st.after(3500, () => {
                const next = hosts.findIndex(x => x.connected);
                if (next !== -1) setHolder(next);
            });
        }
        st.after(5600, () => {
            h.connected = true;
            h.link.setAttribute("data-cut", "false");
            h.cut.setAttribute("opacity", 0);
            h.hsub.textContent = "";
            h.p.state("standby");
            h.p.sub("standby");
            busy = false;
        });
    }

    let idle = null;
    function scheduleIdle(delay = 10500) {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running && !busy) disconnect(holder);
            scheduleIdle();
        }, delay);
    }

    return {
        start() { st.start(); scheduleIdle(3400); if (!reduced) heartbeats(); },
        stop() {
            st.stop();
            if (idle) clearTimeout(idle);
            busy = false;
            hosts.forEach(h => {
                h.connected = true;
                h.inflight = 0;
                h.link.setAttribute("data-cut", "false");
                h.cut.setAttribute("opacity", 0);
                h.hsub.textContent = "";
            });
            setHolder(holder);
        },
    };
});

// ---------- Cluster: every shape at once, wired to the broker ----------

scene("cluster", svg => {
    const st = new Stage();

    const members = el("text", { class: "h-label", x: 260, y: 24 }, "members: 3");
    svg.appendChild(members);

    const box = el("g");
    box.appendChild(el("rect", { class: "host", x: 135, y: 170, width: 250, height: 122, rx: 10 }));
    box.appendChild(el("text", { class: "h-label", x: 260, y: 188 }, "broker"));
    svg.appendChild(box);

    const chans = [];
    for (const c of [{ name: "orders", y: 198 }, { name: "invoices", y: 246 }]) {
        const g = el("g");
        g.appendChild(el("rect", { class: "chan", x: 155, y: c.y, width: 210, height: 26, rx: 8 }));
        g.appendChild(el("text", { class: "h-sub", x: 260, y: c.y + 40 }, c.name));
        svg.appendChild(g);
        chans.push({ y: c.y, q: [], seq: 0 });
    }
    const orders = chans[0], invoices = chans[1];

    const RR = 8, RC = 2 * Math.PI * RR;
    const hosts = [];
    // Each host runs an api (Each); two hosts carry the Many pool
    // that drains orders; the third holds the Solo mailer draining
    // invoices.
    const seconds = ["pool-1", "pool-2", "mailer"];
    for (let i = 0; i < 3; i++) {
        const x = 20 + i * 170;
        const bx = 185 + i * 75;
        const link = rail(x + 75, 144, bx, 170);
        link.setAttribute("class", "hb-link");
        svg.appendChild(link);
        const mx = (x + 75 + bx) / 2;
        const retry = el("circle", {
            class: "backoff-ring", cx: mx, cy: 157, r: RR,
            "stroke-dasharray": RC, "stroke-dashoffset": 0, opacity: 0,
            transform: `rotate(-90 ${mx} 157)`,
        });
        svg.appendChild(retry);
        const g = el("g", { class: "host-g" });
        g.appendChild(el("rect", { class: "host", x, y: 40, width: 150, height: 104, rx: 10 }));
        g.appendChild(el("text", { class: "h-label", x: x + 75, y: 62 }, `host-${i + 1}`));
        const hsub = el("text", { class: "h-sub", x: x + 75, y: 78 }, "");
        g.appendChild(hsub);
        const api = proc(x + 45, 104, "api", { r: 11, state: "running" });
        api.classList.add("sm");
        g.appendChild(api);
        const worker = proc(x + 105, 104, seconds[i], { r: 11, state: "running" });
        worker.classList.add("sm");
        if (seconds[i] === "mailer") {
            worker.appendChild(el("circle", { class: "claim-ring", r: 17 }));
        }
        g.appendChild(worker);
        svg.appendChild(g);
        hosts.push({
            g, hsub, x, link, retry,
            api, worker, role: seconds[i],
            up: true, blip: false, holding: null,
            apiDown: false, workerDown: false, wire: 0,
        });
    }

    let n = 3, zeroing = false;
    const btn = document.querySelector('#cluster .ctl[data-act="zero"]');

    function sync() {
        members.textContent = "members: " + n;
        for (const c of chans) {
            c.q.forEach((d, i) => {
                d.style.transform = `translate(${172 + i * 26}px, ${c.y + 13}px)`;
            });
        }
    }

    function mkdot(num, x, y) {
        const g = el("g", { class: "qdot" });
        g.style.transform = `translate(${x}px, ${y}px)`;
        g.appendChild(el("circle", { r: 8 }));
        g.appendChild(el("text", { y: 3.5 }, String(num)));
        svg.appendChild(g);
        return g;
    }

    const canSend = h => h.up && !h.blip && !h.apiDown;
    const canWork = h => h.up && !h.blip && !h.workerDown && !h.holding;

    function feed() {
        st.after(1600 + Math.random() * 700, () => {
            const l = hosts.filter(canSend);
            const c = orders;
            if (!zeroing && l.length && c.q.length < 6) {
                const h = l[Math.floor(Math.random() * l.length)];
                c.seq++;
                h.wire++;
                const d = mkdot(c.seq, h.x + 45, 116);
                const r = rail(h.x + 45, 116, 172 + c.q.length * 26, c.y + 13);
                svg.appendChild(r);
                travel(st, svg, r, {
                    node: d, dur: 550,
                    onArrive() {
                        h.wire--;
                        r.remove();
                        d.classList.add("parked");
                        c.q.push(d);
                        sync();
                    },
                });
            }
            feed();
        });
    }

    function dispatch(c, eligible) {
        const l = hosts.filter(h => eligible(h) && canWork(h));
        if (!l.length) return;
        const claimIdx = c.q.findIndex(d => !d.dataset.claimed);
        if (claimIdx === -1) return;
        const h = l[Math.floor(Math.random() * l.length)];
        const orig = c.q[claimIdx];
        orig.dataset.claimed = "1";
        orig.classList.add("claimed");
        const num = orig.querySelector("text").textContent;
        const copy = mkdot(num, 172 + claimIdx * 26, c.y + 13);
        const r = rail(172 + claimIdx * 26, c.y + 13, h.x + 105, 104);
        svg.appendChild(r);
        const release = () => {
            delete orig.dataset.claimed;
            orig.classList.remove("claimed");
        };
        h.wire++;
        travel(st, svg, r, {
            node: copy, dur: 550,
            onArrive() {
                if (!h.up || h.workerDown) {
                    travel(st, svg, r, {
                        node: copy, dur: 550, reverse: true,
                        onArrive() {
                            h.wire--;
                            r.remove();
                            copy.remove();
                            release();
                        },
                    });
                    return;
                }
                h.wire--;
                r.remove();
                h.holding = { copy, orig, c, release };
                st.after(1100, () => {
                    if (h.holding && h.holding.copy === copy) {
                        copy.remove();
                        const i = c.q.indexOf(orig);
                        if (i !== -1) c.q.splice(i, 1);
                        orig.remove();
                        sync();
                        h.holding = null;
                        bill(h, c);
                    }
                });
            },
        });
    }

    // Acking an order emits its invoice.
    function bill(h, c) {
        if (c !== orders || zeroing || !h.up || invoices.q.length >= 6) {
            return;
        }
        invoices.seq++;
        h.wire++;
        const d = mkdot(invoices.seq, h.x + 105, 116);
        const r = rail(h.x + 105, 116,
            172 + invoices.q.length * 26, invoices.y + 13);
        svg.appendChild(r);
        travel(st, svg, r, {
            node: d, dur: 550,
            onArrive() {
                h.wire--;
                r.remove();
                d.classList.add("parked");
                invoices.q.push(d);
                sync();
            },
        });
    }

    function consume() {
        st.after(2100, () => {
            if (!zeroing) {
                dispatch(orders, h => h.role !== "mailer");
                dispatch(invoices, h => h.role === "mailer");
            }
            consume();
        });
    }

    function nakHome(h) {
        if (!h.holding) return;
        const { copy, orig, c, release } = h.holding;
        h.holding = null;
        const i = c.q.indexOf(orig);
        const r = rail(172 + Math.max(0, i) * 26, c.y + 13, h.x + 105, 104);
        svg.appendChild(r);
        travel(st, svg, r, {
            node: copy, dur: 550, reverse: true,
            onArrive() {
                r.remove();
                copy.remove();
                release();
            },
        });
    }

    // Procs crash — mostly error returns, sometimes a panic — and
    // the host doesn't notice.
    function crashes() {
        st.after(5500 + Math.random() * 3000, () => {
            const l = hosts.filter(h => h.up);
            if (l.length) {
                const h = l[Math.floor(Math.random() * l.length)];
                const worker = Math.random() < 0.5;
                const p = worker ? h.worker : h.api;
                if (worker) {
                    h.workerDown = true;
                    nakHome(h);
                } else {
                    h.apiDown = true;
                }
                p.state("crashed");
                st.after(1200, () => {
                    if (!h.up) return;
                    p.state("running");
                    p.sub("");
                    if (worker) h.workerDown = false;
                    else h.apiDown = false;
                });
            }
            crashes();
        });
    }

    function blip() {
        st.after(8000 + Math.random() * 3000, () => {
            // Only cut a line that has nothing riding it.
            const l = hosts.filter(h => h.up && h.wire === 0 && !h.holding);
            if (l.length) {
                const h = l[Math.floor(Math.random() * l.length)];
                h.blip = true;
                h.link.setAttribute("data-cut", "true");
                h.hsub.textContent = "retrying";
                h.retry.setAttribute("opacity", 1);
                h.retry.style.transition = "none";
                h.retry.style.strokeDashoffset = String(RC);
                void h.retry.getBoundingClientRect();
                h.retry.style.transition = "stroke-dashoffset 1400ms linear";
                h.retry.style.strokeDashoffset = "0";
                st.after(1400, () => {
                    h.blip = false;
                    h.retry.setAttribute("opacity", 0);
                    if (h.up) {
                        h.link.setAttribute("data-cut", "false");
                        h.hsub.textContent = "";
                    }
                });
            }
            blip();
        });
    }

    function kill(h) {
        h.up = false;
        h.g.setAttribute("data-dead", "true");
        h.link.setAttribute("data-cut", "true");
        h.retry.setAttribute("opacity", 0);
        h.hsub.textContent = "";
        h.api.state("hidden");
        h.worker.state("hidden");
        nakHome(h);
        n--;
        sync();
    }

    function zero() {
        if (!st.running || zeroing) return;
        zeroing = true;
        if (btn) btn.disabled = true;
        scheduleIdle();
        // Let in-flight sends land before topping up, or the
        // stuffed numbers would outrun them.
        const stuff = () => {
            if (hosts.some(h => h.wire > 0)) {
                st.after(150, stuff);
                return;
            }
            for (const c of chans) {
                while (c.q.length < 2) {
                    c.seq++;
                    const d = mkdot(c.seq, 172 + c.q.length * 26, c.y + 13);
                    d.classList.add("parked");
                    c.q.push(d);
                }
            }
            sync();
        };
        stuff();
        hosts.forEach((h, i) => st.after(800 + i * 500, () => kill(h)));
        hosts.forEach((h, i) => st.after(4200 + i * 700, () => {
            h.up = true;
            h.apiDown = false;
            h.workerDown = false;
            h.g.setAttribute("data-dead", "false");
            h.link.setAttribute("data-cut", "false");
            h.api.state("running");
            h.api.sub("");
            h.worker.state("running");
            h.worker.sub("");
            n++;
            sync();
        }));
        st.after(7000, () => {
            zeroing = false;
            if (btn) btn.disabled = false;
        });
    }

    let idle = null;
    function scheduleIdle(delay = 16000) {
        if (idle) clearTimeout(idle);
        if (reduced) return;
        idle = setTimeout(() => {
            if (st.running && !zeroing) zero();
            scheduleIdle();
        }, delay);
    }

    return {
        start() {
            st.start();
            zeroing = false;
            if (btn) btn.disabled = false;
            scheduleIdle(5200);
            if (!reduced) { feed(); consume(); crashes(); blip(); }
        },
        stop() {
            st.stop();
            if (idle) clearTimeout(idle);
            zeroing = false;
            n = 3;
            members.textContent = "members: 3";
            for (const c of chans) {
                for (const d of c.q) d.remove();
                c.q.length = 0;
            }
            hosts.forEach(h => {
                if (h.holding) { h.holding.copy.remove(); h.holding = null; }
                h.up = true;
                h.blip = false;
                h.wire = 0;
                h.apiDown = false;
                h.workerDown = false;
                h.g.setAttribute("data-dead", "false");
                h.link.setAttribute("data-cut", "false");
                h.retry.setAttribute("opacity", 0);
                h.hsub.textContent = "";
                h.api.state("running");
                h.api.sub("");
                h.worker.state("running");
                h.worker.sub("");
            });
        },
        acts: { zero },
    };
});

// ---------- Controls ----------

for (const btn of document.querySelectorAll(".ctl")) {
    btn.addEventListener("click", () => {
        const sec = btn.closest(".scene");
        const sim = sims[sec.id === "top" ? "hero" : sec.id];
        const act = sim && sim.acts && sim.acts[btn.dataset.act];
        if (act) act();
    });
}

// ---------- Rail ----------

const sections = [...document.querySelectorAll(".scene[id]")];
{
    const nav = document.querySelector(".rail");
    for (const s of sections) {
        const a = document.createElement("a");
        a.href = "#" + s.id;
        a.title = s.dataset.title;
        a.setAttribute("aria-label", s.dataset.title);
        nav.appendChild(a);
    }
}

// ---------- Rail labels track the rendered SVG label size ----------

{
    const size = () => {
        const svg = document.querySelector(".scene-stage svg");
        if (!svg) return;
        // getBoundingClientRect, not clientWidth: Firefox reports 0
        // for SVG clientWidth.
        const w = svg.getBoundingClientRect().width;
        if (!w) return;
        const px = 12 * w / 520;
        document.documentElement.style.setProperty(
            "--node-label-size", px.toFixed(2) + "px");
    };
    size();
    addEventListener("resize", size);
}

// ---------- Scroll spy: activate sims, sync URL ----------

let current = null;

function activate(id) {
    if (id === current) return;
    const prev = current;
    current = id;
    const simFor = x => sims[x === "top" ? "hero" : x];
    if (prev && simFor(prev)) simFor(prev).stop();
    const sim = simFor(id);
    if (sim) sim.start();
    for (const a of document.querySelectorAll(".rail a")) {
        a.setAttribute("aria-current", a.getAttribute("href") === "#" + id);
    }
    const sec = sections.find(s => s.id === id);
    const path = id === "top" ? "/" : `/${id}/`;
    const title = id === "top"
        ? "procfunc — services the size of functions"
        : `procfunc — ${sec.dataset.title}`;
    try { history.replaceState(null, "", path); } catch { }
    document.title = title;
}

{
    const visible = new Map();
    const obs = new IntersectionObserver(entries => {
        for (const e of entries) {
            visible.set(e.target.id, {
                px: e.intersectionRect.height,
                frac: e.intersectionRect.height /
                    Math.max(1, e.boundingClientRect.height),
            });
        }
        let best = null, bestPx = 0;
        for (const [id, v] of visible) {
            if (v.px > bestPx) { best = id; bestPx = v.px; }
        }
        if (!best) return;
        const v = visible.get(best);
        if (v.px > innerHeight * 0.4 || v.frac > 0.6) activate(best);
    }, { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] });
    for (const s of sections) obs.observe(s);
}

document.addEventListener("visibilitychange", () => {
    const sim = current && sims[current === "top" ? "hero" : current];
    if (!sim) return;
    if (document.hidden) sim.stop();
    else sim.start();
});

// ---------- Deep links: /solo/ or #solo scrolls to the scene ----------

{
    const seg = location.hash
        ? location.hash.slice(1)
        : location.pathname.replace(/\/+$/, "").split("/").pop();
    if (seg && seg !== "top" && sections.some(s => s.id === seg)) {
        document.getElementById(seg)
            .scrollIntoView({ behavior: "instant", block: "start" });
    }
}
