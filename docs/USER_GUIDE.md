# Channel Guard: user guide

Channel Guard is a Slack app that keeps selected **private channels** restricted. In a
**locked** channel, only approved people can add new members. If anyone else adds someone, Channel
Guard removes that person again within a few seconds and explains why.

Questions or access requests: ask a bot admin.

---

## Who is who

| Role | Who | Can do |
|---|---|---|
| **Bot admin** | People listed in the server config (see `/channel-guard list`) | Everything: lock/unlock channels, manage inviters, use `/channel-guard` |
| **Authorized inviter** | People added by a bot admin (see `/channel-guard list`) | Add people to any locked channel |
| **Member** | Everyone else in a locked channel | Use the channel normally, but **can't add people** |

Slack Workspace Admins and Owners are **not** automatically authorized. They need to be added as
inviters like anyone else.

---

## For members: what you'll notice

- **You add someone to a locked channel** -> they appear briefly and are removed within seconds.
  You get a DM from Channel Guard:
  > *@Person was removed from #channel because membership of that channel is restricted. To add
  > someone, ask one of: @Admin, @Inviter, ...*
- **To get someone added**, ask one of the people listed in that DM.
- **You can't reply to Channel Guard.** Its DMs are notifications only.
- Nothing changes for people already in the channel. Channel Guard never removes existing members.

---

## For authorized inviters

- Add people to locked channels as usual (channel name -> **Add people**). They stay.
- Your permission covers **all** locked channels.
- People **you** add can be anyone; they don't need to be on a list.

---

## For bot admins: commands

All replies are visible only to you. Pick channels and people from Slack's autocomplete;
typed text like `@alice` or `#general` is rejected on purpose.

| Command | What it does |
|---|---|
| `/channel-guard lock` | Lock the channel you're in |
| `/channel-guard lock #channel` | Lock another channel |
| `/channel-guard unlock [#channel]` | Stop guarding a channel |
| `/channel-guard add @person` | Make someone an authorized inviter |
| `/channel-guard remove @person` | Take that permission away |
| `/channel-guard list` | Show locked channels, admins and inviters |
| `/channel-guard status [#channel]` | Is this channel locked, by whom, since when? |
| `/channel-guard help` | Show the command list |

### Lock a new channel

1. Open the private channel and run `/invite @Channel Guard`.
2. Run `/channel-guard lock`. Expect: *🔒 #channel is now locked.*
3. Optional: remove members who shouldn't be there **before** locking; locking doesn't check
   existing members.
4. Make sure everyone who should be able to add people is an inviter (`/channel-guard list`,
   then `/channel-guard add @person`).

If the lock is refused:

| Reply | Meaning |
|---|---|
| *I can't see #channel (`channel_not_found`)* | The bot isn't in the channel yet. Do step 1. |
| *Not locked. The bot ... is not in #channel* | Same: `/invite @Channel Guard` first. |
| *Channel Guard only guards private channels* | Public channels can't be locked (anyone can join them anyway). |
| *Channels can only be locked from inside a channel* | You ran it in a DM. Name a channel or run it in the channel. |

### Make someone a bot admin

Bot admins are configured on the server, not with a command. Ask an engineer (see the technical
documentation, "Change configuration").

---

## FAQ

**Someone I added was removed. Why?**
The channel is locked and you're not an authorized inviter. Ask one of the people named in
Channel Guard's DM to add them.

**Does locking a channel remove people already in it?**
No. Only people added **after** the lock are checked.

**Can a removed person see messages?**
They're in the channel for a few seconds before removal, so they may briefly see recent history.
Slack offers no way to block an add before it happens on our plan.

**What if someone joins without being invited?**
That's only possible in channels people can find and join themselves. By default this is logged
but not removed.

**What if Channel Guard is offline?**
People added while it's offline are not removed later. It runs on a server around the clock and
restarts automatically, so this is rare.

**Someone removed Channel Guard from a channel.**
Then that channel is no longer guarded. Run `/invite @Channel Guard` again; the lock is kept.

**Can I lock a public channel?**
No, Channel Guard only works with private channels.

**Removal failed and I got a warning DM** (bot admins only)
The DM contains the Slack error and what to do. Usually the bot was removed from the channel
(`not_in_channel`: invite it again). Forward anything else to an engineer.
