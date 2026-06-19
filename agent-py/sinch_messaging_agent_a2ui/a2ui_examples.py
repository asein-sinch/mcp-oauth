# a2ui_examples.py

ONBOARDING_START_EXAMPLE = r"""{
  "a2ui_messages": [
    {
      "beginRendering": {
        "surfaceId": "main",
        "root": "root_card"
      }
    },
    {
      "surfaceUpdate": {
        "surfaceId": "main",
        "components": [
          {
            "id": "root_card",
            "component": {
              "Card": {
                "child": "card_col"
              }
            }
          },
          {
            "id": "card_col",
            "component": {
              "Column": {
                "children": {
                  "explicitList": [
                    "step_header",
                    "sender_name_tf",
                    "next_btn_row"
                  ]
                }
              }
            }
          },
          {
            "id": "step_header",
            "component": {
              "Text": {
                "text": {
                  "literalString": "RCS Onboarding: Step 1 of 3"
                },
                "usageHint": "h2"
              }
            }
          },
          {
            "id": "sender_name_tf",
            "component": {
              "TextField": {
                "label": {
                  "literalString": "Sender Name (Brand Name)"
                },
                "text": {
                  "path": "sender_name"
                }
              }
            }
          },
          {
            "id": "next_btn_row",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "next_btn"
                  ]
                },
                "distribution": "end"
              }
            }
          },
          {
            "id": "next_btn",
            "component": {
              "Button": {
                "child": "next_btn_txt",
                "primary": true,
                "action": {
                  "name": "submit",
                  "context": [
                    {
                      "key": "message",
                      "value": {
                        "literalString": "Onboard sender with name"
                      }
                    },
                    {
                      "key": "sender_name",
                      "value": {
                        "path": "sender_name"
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "next_btn_txt",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Next"
                }
              }
            }
          }
        ]
      }
    },
    {
      "dataModelUpdate": {
        "surfaceId": "main",
        "path": "/",
        "contents": [
          {
            "key": "sender_name",
            "valueString": ""
          }
        ]
      }
    }
  ]
}"""

TESTER_WARNING_EXAMPLE = r"""{
  "a2ui_messages": [
    {
      "beginRendering": {
        "surfaceId": "main",
        "root": "warning_card"
      }
    },
    {
      "surfaceUpdate": {
        "surfaceId": "main",
        "components": [
          {
            "id": "warning_card",
            "component": {
              "Card": {
                "child": "warning_col"
              }
            }
          },
          {
            "id": "warning_col",
            "component": {
              "Column": {
                "children": {
                  "explicitList": [
                    "warning_title",
                    "warning_text",
                    "action_row"
                  ]
                }
              }
            }
          },
          {
            "id": "warning_title",
            "component": {
              "Text": {
                "text": {
                  "literalString": "⚠️ Tester Verification Warning"
                },
                "usageHint": "h2"
              }
            }
          },
          {
            "id": "warning_text",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Adding a tester phone number will send a carrier-level verification invite message. The recipient must opt-in (accept this invite) before they can receive any RCS messages."
                }
              }
            }
          },
          {
            "id": "action_row",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "btn_yes",
                    "btn_no"
                  ]
                },
                "distribution": "end"
              }
            }
          },
          {
            "id": "btn_yes",
            "component": {
              "Button": {
                "child": "btn_yes_txt",
                "primary": true,
                "action": {
                  "name": "submit",
                  "context": [
                    {
                      "key": "message",
                      "value": {
                        "literalString": "Yes, I want to add tester numbers"
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "btn_yes_txt",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Yes, Add Testers"
                }
              }
            }
          },
          {
            "id": "btn_no",
            "component": {
              "Button": {
                "child": "btn_no_txt",
                "action": {
                  "name": "submit",
                  "context": [
                    {
                      "key": "message",
                      "value": {
                        "literalString": "No, skip adding tester numbers"
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "btn_no_txt",
            "component": {
              "Text": {
                "text": {
                  "literalString": "No, Skip"
                }
              }
            }
          }
        ]
      }
    }
  ]
}"""

CAMPAIGN_PREVIEW_EXAMPLE = r"""{
  "a2ui_messages": [
    {
      "beginRendering": {
        "surfaceId": "main",
        "root": "campaign_card"
      }
    },
    {
      "surfaceUpdate": {
        "surfaceId": "main",
        "components": [
          {
            "id": "campaign_card",
            "component": {
              "Card": {
                "child": "campaign_col"
              }
            }
          },
          {
            "id": "campaign_col",
            "component": {
              "Column": {
                "children": {
                  "explicitList": [
                    "card_title",
                    "media_box",
                    "card_desc",
                    "send_btn_row"
                  ]
                }
              }
            }
          },
          {
            "id": "card_title",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Generated RCS Campaign Card"
                },
                "usageHint": "h2"
              }
            }
          },
          {
            "id": "media_box",
            "component": {
              "Image": {
                "url": {
                  "literalString": "https://images.unsplash.com/photo-1542291026-7eec264c27ff"
                },
                "usageHint": "header"
              }
            }
          },
          {
            "id": "card_desc",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Title: Running Shoe Sale\nDescription: 20% off all top brands this weekend. Tap below to buy!"
                }
              }
            }
          },
          {
            "id": "send_btn_row",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "refine_btn",
                    "send_btn"
                  ]
                },
                "distribution": "end"
              }
            }
          },
          {
            "id": "refine_btn",
            "component": {
              "Button": {
                "child": "refine_txt",
                "action": {
                  "name": "submit",
                  "context": [
                    {
                      "key": "message",
                      "value": {
                        "literalString": "Refine the campaign tone to be more urgent."
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "refine_txt",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Refine Tone"
                }
              }
            }
          },
          {
            "id": "send_btn",
            "component": {
              "Button": {
                "child": "send_txt",
                "primary": true,
                "action": {
                  "name": "submit",
                  "context": [
                    {
                      "key": "message",
                      "value": {
                        "literalString": "Proceed to send this campaign"
                      }
                    }
                  ]
                }
              }
            }
          },
          {
            "id": "send_txt",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Send Campaign"
                }
              }
            }
          }
        ]
      }
    }
  ]
}"""

INSIGHTS_REPORT_EXAMPLE = r"""{
  "a2ui_messages": [
    {
      "beginRendering": {
        "surfaceId": "main",
        "root": "insights_card"
      }
    },
    {
      "surfaceUpdate": {
        "surfaceId": "main",
        "components": [
          {
            "id": "insights_card",
            "component": {
              "Card": {
                "child": "insights_col"
              }
            }
          },
          {
            "id": "insights_col",
            "component": {
              "Column": {
                "children": {
                  "explicitList": [
                    "insights_title",
                    "metrics_desc",
                    "table_header",
                    "rcs_row",
                    "sms_row"
                  ]
                }
              }
            }
          },
          {
            "id": "insights_title",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Messaging Insights (Weekly Report)"
                },
                "usageHint": "h2"
              }
            }
          },
          {
            "id": "metrics_desc",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Total Sent: 17,305 | Total Delivered: 17,061 (98.6%) | Failed: 244"
                }
              }
            }
          },
          {
            "id": "table_header",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "th_channel",
                    "th_sent",
                    "th_delivered",
                    "th_read"
                  ]
                }
              }
            }
          },
          {
            "id": "th_channel",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Channel"
                },
                "usageHint": "h5"
              }
            }
          },
          {
            "id": "th_sent",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Sent"
                },
                "usageHint": "h5"
              }
            }
          },
          {
            "id": "th_delivered",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Delivered"
                },
                "usageHint": "h5"
              }
            }
          },
          {
            "id": "th_read",
            "component": {
              "Text": {
                "text": {
                  "literalString": "Read Rate"
                },
                "usageHint": "h5"
              }
            }
          },
          {
            "id": "rcs_row",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "td_rcs_name",
                    "td_rcs_sent",
                    "td_rcs_deliv",
                    "td_rcs_read"
                  ]
                }
              }
            }
          },
          {
            "id": "td_rcs_name",
            "component": {
              "Text": {
                "text": {
                  "literalString": "RCS"
                }
              }
            }
          },
          {
            "id": "td_rcs_sent",
            "component": {
              "Text": {
                "text": {
                  "literalString": "15,430"
                }
              }
            }
          },
          {
            "id": "td_rcs_deliv",
            "component": {
              "Text": {
                "text": {
                  "literalString": "15,201"
                }
              }
            }
          },
          {
            "id": "td_rcs_read",
            "component": {
              "Text": {
                "text": {
                  "literalString": "88%"
                }
              }
            }
          },
          {
            "id": "sms_row",
            "component": {
              "Row": {
                "children": {
                  "explicitList": [
                    "td_sms_name",
                    "td_sms_sent",
                    "td_sms_deliv",
                    "td_sms_read"
                  ]
                }
              }
            }
          },
          {
            "id": "td_sms_name",
            "component": {
              "Text": {
                "text": {
                  "literalString": "SMS Fallback"
                }
              }
            }
          },
          {
            "id": "td_sms_sent",
            "component": {
              "Text": {
                "text": {
                  "literalString": "1,875"
                }
              }
            }
          },
          {
            "id": "td_sms_deliv",
            "component": {
              "Text": {
                "text": {
                  "literalString": "1,860"
                }
              }
            }
          },
          {
            "id": "td_sms_read",
            "component": {
              "Text": {
                "text": {
                  "literalString": "N/A"
                }
              }
            }
          }
        ]
      }
    }
  ]
}"""
