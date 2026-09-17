"use strict";
/* What a brand new database starts with: the places people name, the people who
   name them, a few recurring inspections, and the issues that were already on
   the old board. Each list is inserted once, when its table is first created.

   The aliases matter more than the names. A report says "2017 gardens", "Nat
   Geo", "5D triangle" or "second gathering nook" interchangeably, so the picker
   has to match on all of them — and still accept free text, because about a
   third of reports say something like "furthest north old islands". */

const LOCATIONS = [
  // Gardens and island sections
  ["2017 Garden", "garden", ["2017", "2017 gardens", "2017 islands", "2017 install"]],
  ["2020 Garden", "garden", ["2020", "2020 north end", "north end"]],
  ["5D", "garden", ["5d moat", "5d triangle", "5 d", "triangle"]],
  ["Diamond", "garden", ["dimond", "diamond section", "east section"]],
  ["Nat Geo", "garden", ["natgeo", "nat geo island", "national geographic"]],
  ["Shedd", "garden", ["shedd 1", "shedd 2", "shedd aquarium modules"]],
  ["British School gardens", "garden", ["british school", "bsc"]],
  ["Waste Management wall", "garden", ["wm", "wm wall", "waste mgmt", "wm infrastructure"]],
  ["WF modules", "garden", ["wf"]],
  ["Little Goose Island", "garden", ["goose island", "little goose"]],
  ["Learning platform", "garden", ["learning platform section"]],
  ["Submerged modules", "garden", ["submerged", "submerged trays", "lower submerged module trays"]],
  ["Mesocosms", "garden", ["mesocosm"]],
  ["Bubbly", "garden", ["bubbly creek"]],
  ["New section", "garden", ["new section of the wild mile", "juncus area"]],
  ["Furthest north old islands", "garden", ["north old islands", "old islands"]],

  // Built structures and visitor surfaces
  ["Boardwalk", "structure", ["walkway", "deck", "decking"]],
  ["Gangway", "structure", []],
  ["Transition ramp", "structure", ["ada ramp", "ramp", "kebony side"]],
  ["Boat dock", "structure", ["dock", "boat dock corner", "ladder at end of dock"]],
  ["Gathering nooks", "structure", ["second gathering nook", "first gathering nook", "nook"]],
  ["Curbing", "structure", ["curb", "curb repair"]],
  ["Courtyard", "structure", []],
  ["Overlook", "structure", []],
  ["Seawall", "structure", []],
  ["Riverwalk", "structure", []],
  ["Wake barriers", "structure", ["wake barrier", "no wake"]],
  ["Bird fencing", "structure", ["bird fence", "fence", "fencing"]],
  ["Beaver skirts", "structure", ["beaver fence", "tree skirt"]],

  // Off water and support
  ["Shipping container", "support", ["container", "storage container"]],
  ["Tool room", "support", ["tool shed", "tool room top shelf"]],
  ["mHub storage", "support", ["mhub"]],
  ["Kayak Chicago", "support", ["kc", "kayak launch"]],
  ["Prologis", "support", []],
  ["Turning basin", "support", []],

  // Things that move. They are not places, but people file against them anyway,
  // and the van's steering column had nowhere else to go.
  ["Boat", "asset", ["codfather", "trolling motor", "outboard", "hull"]],
  ["Van", "asset", ["truck"]],
  ["E-ink sign", "asset", ["eink", "e ink", "sign"]],
  ["Camera", "asset", ["ubiquiti", "g4 ptz", "ptz"]],
  ["Eco-counter", "asset", ["ecocounter", "counter"]],
  ["Robots", "asset", ["trashbot", "bouncer bot"]],
  ["Wild Mile (unspecified)", "other", ["wild mile", "site", "various"]]
].map(([name, kind, aliases], i) => ({
  id: "loc-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  name, kind, aliases, sort: (i + 1) * 10
}));

/* The people who report and fix, as the channel shows them. Names only. */
const PEOPLE = [
  ["Nick Wesley", "staff"],
  ["Phil Nicodemus", "staff"],
  ["Stephen Meyer", "staff"],
  ["Maya Kelly", "staff"],
  ["Christopher Riccardo", "staff"],
  ["Peter Nagle", "partner"],
  ["Sage Rossman", "volunteer"],
  ["Joe Cannon", "volunteer"]
].map(([name, role]) => ({
  id: "ppl-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, role
}));

/* Recurring inspections, with the cadence the channel actually states. They
   generate nothing until somebody asks them to, so a fresh board is not buried
   in auto-created work on day one. */
const TEMPLATES = [
  {
    id: "tpl-hardware-check",
    title: "Hardware check-up",
    descr: "Walk the anchors, connector poles, pins and bolts. Log anything loose as its own issue.",
    severity: "Keep eyes on",
    location_text: "Wild Mile (unspecified)",
    cadence: "every_days", interval_days: 14,
    season_start: "04-01", season_end: "11-15"
  },
  {
    id: "tpl-weeding",
    title: "Weeding round",
    descr: "Roughly four times a season, about a month apart, first round mid-to-late May.",
    severity: "Keep eyes on",
    location_text: "2017 Garden",
    cadence: "every_days", interval_days: 30,
    season_start: "05-15", season_end: "09-30"
  },
  {
    id: "tpl-reed-canary",
    title: "Cut reed canary grass seed heads",
    descr: "Phalaris arundinacea. Cut the seed heads before they shed — mid June and again early July.",
    severity: "Important",
    location_text: "2017 Garden",
    cadence: "on_dates", month_days: "06-15,07-05"
  },
  {
    id: "tpl-juncus",
    title: "Juncus cut-back",
    descr: "Cut back to about six inches. Grows back fast, so expect to do it more than once a summer.",
    severity: "Keep eyes on",
    location_text: "New section",
    cadence: "every_days", interval_days: 45,
    season_start: "06-01", season_end: "09-15"
  },
  {
    id: "tpl-winterize",
    title: "Winterization",
    descr: "Boat cover on, anchor weights in, mussel boxes placed, tarps off.",
    severity: "Important",
    location_text: "Wild Mile (unspecified)",
    cadence: "on_dates", month_days: "10-20"
  }
];

/* The issues the shared board was already carrying. Used only when there is no
   cards table to carry over — a database that has been deliberately emptied
   stays empty. */
const ISSUES = [
  {id:"tr-ramp", status:"new", title:"Transition ramp fell in",
   reporter:"Nick Wesley", location_text:"Transition ramp", severity:"Urgent!", reported_on:"2026-04-04",
   descr:"Photo in Slack; couldn't file via the bug form."},
  {id:"eink-plug", status:"new", title:"Eink power plug is not accessible",
   reporter:"Nick Wesley", location_text:"E-ink sign", severity:"Important", reported_on:"2026-06-29", descr:""},
  {id:"geese", status:"new", title:"Geese nesting in wake barriers",
   reporter:"Maya Kelly", location_text:"Wake barriers", severity:"Keep eyes on", reported_on:"2026-04-09",
   descr:"Geese are pulling wake barrier material for nests."},
  {id:"deck-board", status:"new", title:"Cracked, bouncy deck board near second gathering nook",
   reporter:"Maya Kelly", location_text:"Gathering nooks", severity:"Important", reported_on:"2025-07-18",
   descr:"Feels bouncy underfoot; expected to break."},
  {id:"natgeo", status:"new", title:"Nat Geo island hanging on its anchors",
   reporter:"Phil Nicodemus", location_text:"Nat Geo", severity:"Urgent!", reported_on:"2025-10-28", descr:""},
  {id:"north-old", status:"new", title:"Furthest north old islands jacked up",
   reporter:"Phil Nicodemus", location_text:"Furthest north old islands", severity:"Important", reported_on:"2025-10-28", descr:""},
  {id:"dropped-eq", status:"new", title:"Possible dropped equipment in river",
   reporter:"Phil Nicodemus", location_text:"Wild Mile (unspecified)", severity:"Keep eyes on", reported_on:"2025-10-28",
   descr:"“We might have dropped this” — needs ID and retrieval."},
  {id:"fence", status:"new", title:"Fence broken, needs ring gunning",
   reporter:"Sage Rossman", location_text:"Bird fencing", severity:"Keep eyes on", reported_on:"2024-10-23", descr:""},
  {id:"van-steer", status:"new", title:"Van steering column leaking water",
   reporter:"Stephen Meyer", location_text:"Van", severity:"Important", reported_on:"2025-09-13",
   descr:"Water comes out of the steering column when turning the wheel. Not install/maintenance proper."},
  {id:"prologis", status:"scheduled", title:"Prologis fix needed before city tour",
   reporter:"Nick Wesley", location_text:"Prologis", severity:"Urgent!", reported_on:"2026-06-02",
   due_on:"2026-07-23", due_reason:"City tour of Prologis",
   descr:"City tour of Prologis was July 23; confirm whether still outstanding."},
  {id:"bugform", status:"triaged", title:"Open bug-form submissions (Slack list)",
   reporter:"Issue submission form", location_text:"Wild Mile (unspecified)", severity:"Important", reported_on:"",
   descr:"About a dozen submissions live in the Slack bug list; titles aren't readable from the channel feed, so copy them onto the board as they get triaged.",
   source_link:"https://urbanrivers.slack.com/lists/T049JE18R/F0839EZG03H"}
];

module.exports = { LOCATIONS, PEOPLE, TEMPLATES, ISSUES };
