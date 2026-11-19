/* Sends welcome texts and emails through your GoHighLevel workflow.
   Set NOTIFY_WEBHOOK_URL in Netlify to the URL from a GHL "Inbound Webhook" trigger.
   Each post carries ready-to-send text (sms_text, email_subject, email_body) so the workflow only has to map fields. */
export async function notify(payload) {
  const url = process.env.NOTIFY_WEBHOOK_URL || "";
  if (!/^https:\/\//.test(url) && !(process.env.NOTIFY_ALLOW_HTTP && /^http:\/\/localhost/.test(url))) return { sent: false, reason: "not_set" };
  try {
    const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    payload.email_html = esc(payload.email_body || "").replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>').replace(/\n/g, "<br>");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    return r.ok ? { sent: true } : { sent: false, reason: "http_" + r.status };
  } catch (e) { return { sent: false, reason: "error" }; }
}

export function agentInviteMsg({ first, last, phone, email, link, manager }) {
  const m = manager ? `\n\nYour manager is ${manager.name}${manager.phone ? " (" + manager.phone + ")" : ""}. Reach out any time you get stuck.` : "";
  const sms = `Hi ${first}, welcome to the team! Start your Virtual Presentation Academy training here: ${link}${manager ? `\n\nQuestions? Text ${manager.name.split(" ")[0]}${manager.phone ? " at " + manager.phone : ""}.` : ""}`;
  return {
    event: "agent_invite", role: "agent", first_name: first, last_name: last, full_name: `${first} ${last}`, phone, email, link,
    manager_name: manager ? manager.name : "", manager_phone: manager ? manager.phone : "", manager_email: manager ? manager.email : "",
    sms_text: sms,
    email_subject: "Welcome to the team: start your training",
    email_body: `Hi ${first},\n\nWelcome to the team! Your training is ready in the Virtual Presentation Academy. It's self-paced: short lessons, quizzes, and practice calls with an AI family, ending in a live certification exam.\n\nStart here (this link is just for you):\n${link}\n\nUse Chrome on a computer with a headset for the practice calls.${m}\n\nSee you inside!`
  };
}

export function managerWelcomeMsg({ first, last, phone, email, link, temp, reset }) {
  const sms = reset
    ? `Hi ${first}, your Virtual Presentation Academy manager password was reset. Sign in at ${link} with ${email} and the temporary password: ${temp}\nYou'll choose a new password right away.`
    : `Hi ${first}, you've been added as a manager in the Virtual Presentation Academy. Sign in at ${link} with ${email} and the temporary password: ${temp}\nYou'll choose your own password right away.`;
  return {
    event: reset ? "manager_password_reset" : "manager_welcome", role: "manager", first_name: first, last_name: last, full_name: `${first} ${last}`.trim(), phone, email, link, temp_password: temp,
    sms_text: sms,
    email_subject: reset ? "Your manager password was reset" : "You're a manager in the Virtual Presentation Academy",
    email_body: `Hi ${first},\n\n${reset ? "Your manager password was reset." : "You've been added as a manager in the Virtual Presentation Academy. You can invite new agents, track their progress and call scores, and they'll see you as part of their upline."}\n\nSign in here: ${link}\nEmail: ${email}\nTemporary password: ${temp}\n\nYou'll choose your own password the first time you sign in.`
  };
}
