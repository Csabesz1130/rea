// Where a member read on a receiver REA does not resolve (`this.run()`)
// leads: to the functions of that name the nearest enclosing class or
// object defines, as a method or as a class field (`run = async () => …`),
// else to that member of the bindings the class reads outside its methods,
// such as the class it extends (`class OpsServer extends Base`). Release
// Watch matches by name; reach-text.mjs says so. A member read on nodes REA
// reports that do not form one expression (`(a || b).run`) may be on
// `this` or not: it is followed the same way, as a guess.
import { startsBefore, within } from "../ranges.mjs";
import {
  childFunctions,
  enclosingFunction,
  inside,
  scopeOf,
} from "./reach-index.mjs";
import { followRead } from "./reach-resolve.mjs";

// What an inherited member read may select: a function REA's facts place
// under that member, not a whole binding.
const SELECTING = new Set(["member", "named", "written", "slots"]);

// The class or object scope a read inside a method is in: the scope of the
// nearest named function around it, or that function itself when it is a
// class (a class field's function).
const scopeAround = (index, member) => {
  let method = enclosingFunction(index, member.module, member.range);
  while (method && method.name === null)
    method = index.byId.get(scopeOf(index, method));
  if (!method) return undefined;
  return method.kind === "class" ? method.id : scopeOf(index, method);
};

// The functions a class field holds: the unnamed functions the class
// defines after the field's key and before its next key or named member.
const fieldFunctions = (index, member, scope) => {
  const fields = (index.fields.get(member.module) ?? []).filter(
    (field) => field.owner === scope,
  );
  const children = [...childFunctions(index, member.module, scope)].sort(
    (a, b) => startsBefore(a.range, b.range),
  );
  return fields
    .filter((field) => field.name === member.path[0])
    .flatMap((field) => {
      const later = (range) => startsBefore(field.range, range) < 0;
      const next = [
        ...fields.filter((other) => later(other.range)),
        ...children.filter((fn) => fn.name !== null && later(fn.range)),
      ].sort((a, b) => startsBefore(a.range, b.range))[0];
      return children.filter(
        (fn) =>
          fn.name === null &&
          later(fn.range) &&
          (!next || startsBefore(fn.range, next.range) < 0),
      );
    });
};

// The member of each binding a class reads outside its methods (the class
// it extends), as REA's facts select it there.
const inherited = (state, member, owner) => {
  const { index } = state;
  return inside(index.reads.get(member.module), owner.range)
    .filter(
      (item) =>
        enclosingFunction(index, member.module, item.range)?.id === owner.id,
    )
    .flatMap((item) =>
      followRead(state, item, { path: member.path })
        .filter((target) => target.fn && SELECTING.has(target.step.how))
        .map((target) => ({
          ...target,
          via: item.read.data.name,
          step: { ...target.step, forwarded: false },
        })),
    );
};

const thisStep = (member, owner, extra) => ({
  kind: "this-member",
  name: member.path.join("."),
  owner: owner?.name ?? null,
  location: member.location,
  receiver: member.receiver === null ? "none" : "unsettled",
  ...extra,
});

/**
 * The places a member read on a receiver REA does not resolve leads to,
 * each with the steps that explain it: a method or class field of that
 * name the enclosing class or object defines, else that member of a
 * binding the class reads outside its methods. The first step's `receiver`
 * is "none" when REA reports nothing before the member (`this.run`), and
 * "unsettled" when REA's nodes there do not show what it is read on.
 */
export const followBareMember = (state, member) => {
  const { index } = state;
  const scope = scopeAround(index, member);
  if (scope === undefined) return [];
  const owner = scope === null ? null : index.byId.get(scope);
  const name = member.path[0];
  const methods = childFunctions(index, member.module, scope).filter(
    (fn) => fn.name === name,
  );
  if (methods.length > 0)
    return methods.map((fn) => ({
      fn,
      steps: [thisStep(member, owner, { target: fn.name })],
    }));
  const fields = fieldFunctions(index, member, scope);
  if (fields.length > 0)
    return fields.map((fn) => ({
      fn,
      steps: [
        thisStep(member, owner, {
          target: name,
          field: true,
          how: fields.length > 1 || member.path.length > 1 ? "guess" : null,
          selects: name,
        }),
      ],
    }));
  if (owner?.kind !== "class" || !within(member.range, owner.range)) return [];
  return inherited(state, member, owner).map((target) => ({
    fn: target.fn,
    steps: [
      thisStep(member, owner, { target: name, via: target.via }),
      target.step,
    ],
  }));
};
