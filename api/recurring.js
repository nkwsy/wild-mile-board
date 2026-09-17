"use strict";
/* GET    /api/recurring              the inspection templates
   POST   /api/recurring              create one
   POST   /api/recurring?do=generate  make the dated instances that are missing
   PATCH  /api/recurring?id=...       change one
   DELETE /api/recurring?id=...       drop the template, keep its issues        */

const recurring = require("../lib/recurring");
const { send, readJson, query, handler } = require("../lib/http");

module.exports = handler(async (req, res) => {
  const q = query(req);
  const id = q.get("id");

  if (req.method === "GET") {
    if (id) {
      const template = await recurring.getTemplate(id);
      return template ? send(res, 200, { template }) : send(res, 404, { error: "no such template" });
    }
    return send(res, 200, { templates: await recurring.listTemplates() });
  }

  if (req.method === "POST") {
    const body = await readJson(req);
    if (q.get("do") === "generate") {
      return send(res, 200, await recurring.generate({
        templateId: body.templateId || id || "",
        from: body.from, to: body.to, days: body.days, actor: body.actor
      }));
    }
    return send(res, 201, { template: await recurring.createTemplate(body) });
  }

  if (req.method === "PATCH" || req.method === "PUT") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const template = await recurring.updateTemplate(id, await readJson(req));
    return template ? send(res, 200, { template }) : send(res, 404, { error: "no such template" });
  }

  if (req.method === "DELETE") {
    if (!id) return send(res, 400, { error: "missing ?id=" });
    const gone = await recurring.removeTemplate(id);
    return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: "no such template" });
  }

  send(res, 405, { error: "method not allowed" });
});
