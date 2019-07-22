<!-- Do not edit this file. It is automatically generated by API Documenter. -->

[Home](./index.md) &gt; [sip.js](./sip.js.md) &gt; [SessionDialog](./sip.js.sessiondialog.md) &gt; [info](./sip.js.sessiondialog.info.md)

## SessionDialog.info() method

An INFO request can be associated with an Info Package (see Section 5), or associated with a legacy INFO usage (see Section 2).

The construction of the INFO request is the same as any other non-target refresh request within an existing invite dialog usage as described in Section 12.2 of RFC 3261. https://tools.ietf.org/html/rfc6086\#section-4.2.1

<b>Signature:</b>

```typescript
info(delegate?: OutgoingRequestDelegate, options?: RequestOptions): OutgoingInfoRequest;
```

## Parameters

|  Parameter | Type | Description |
|  --- | --- | --- |
|  delegate | <code>OutgoingRequestDelegate</code> |  |
|  options | <code>RequestOptions</code> | Options bucket. |

<b>Returns:</b>

`OutgoingInfoRequest`
