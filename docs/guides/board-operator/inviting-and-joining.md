---
title: Inviting and Joining
summary: Invite a human teammate and understand the approval path
---

Human teammates join with a Google identity. AoA binds an email-targeted invite
to the intended address, carries the selected role and reporting scope, and
records a durable join request.

## Create an Invite

Open **Team**, choose **Invite teammate**, and keep **Invite by email** selected.
Enter:

- the teammate's email address;
- **Team Member** or **Team Lead**;
- a department when inviting a Team Lead;
- an optional person they report to.

Choose **Create link**, then copy the generated URL. Email-bound, human-only
invite links expire after seven days. Resending revokes the old link and creates
a new token with a fresh expiry.

The invite link is a credential. Send it only to the intended teammate. You can
revoke an unused link from Team; an accepted link cannot be revoked or resent.

## What the Teammate Sees

The teammate signs in with Google and completes the Human Operating Profile:
name, title, and timezone are required; bio and social links are optional.

There are two supported entry paths:

- **Invite-link entry.** The teammate opens the link, chooses to join as a
  human, and submits the join request.
- **Verified-email discovery.** If the teammate signs in without opening the
  link, AoA can detect an open invite matching their verified Google email.
  Detection alone does not join them. AoA names the organization and requires
  an explicit **Join** click before it claims the invite.

AoA never returns an invite token from the post-auth journey endpoint. Link
acceptance and tokenless consent are handled server-side.

## Automatic Admission and Approval

If the verified Google email matches the email on an ordinary Team Member or
Team Lead invite, the invitation carries the approval and AoA admits the user
automatically.

The request remains pending for founder approval when:

- the signed-in email does not match the invited email;
- the Google email is not verified; or
- the invite would confer founder-level or otherwise privileged authority.

The join screen polls while approval is pending and enters the organization
after approval. A rejected request shows a not-approved state.

## Reinvite After Rejection

Create a fresh invite for the teammate. When they explicitly accept the new
invite, AoA ignores the stale rejection, files a new request, and applies the
new invite's role and scope. The newest open invite for that organization wins.

## Direct Add

**Add manually** grants immediate access without invite acceptance or email
verification. AoA shows a confirmation before applying it. Use this only when
you have independently verified the identity; email invite is the safer default.

Only an instance administrator can offer the Founder role. Team Leads must be
scoped to a department.

For endpoint fields and statuses, see [Onboarding API](../../api/onboarding.md)
and [Team API](../../api/team.md).
